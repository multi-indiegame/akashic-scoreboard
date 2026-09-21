/**
 * akashic serve のブラウザ側で、記録を画面に出すプラグイン。
 *
 * ゲーム開発者が sandbox.config.js の client.external から参照する。使い方は
 * このパッケージの README.md を見ること。
 *
 * WHY: 記録が登録されるのはサーバ側（`server.external`）で、ここからは見えない。
 * サーバ側が playlog へ流したスナップショットを、パッシブインスタンスのティックから
 * 拾って表示する。cli-serve には `server.external` からブラウザへ送信する口が無いため。
 *
 * WHY: akashic serve は client.external に渡された 1 ファイルを、module と exports
 * しか無いスコープで評価する。require() が無いので依存はすべてバンドルする
 * （scripts/build-plugin.js）。
 */
import {
    button,
    create,
    getDock,
} from "@multi-indiegame/akashic-serve-extension-dock";
import { DecodedSnapshot, decodeSnapshot, RecordSnapshot } from "./channel";

/** akashic serve がページに出しているもののうち、使う部分だけ */
interface TickArguments {
    events?: unknown[];
}

interface TriggerLike {
    add(handler: (arg: TickArguments) => void): void;
}

interface GameContentLike {
    onTick?: TriggerLike;
}

interface ServeGlobals {
    store?: {
        currentLocalInstance?: { gameContent?: GameContentLike } | null;
        currentPlay?: { playId?: number } | null;
    } | null;
}

const serve = (): ServeGlobals | null => {
    const host = window as unknown as {
        akashicServe?: ServeGlobals;
        __testbed?: ServeGlobals;
    };
    return host.akashicServe ?? host.__testbed ?? null;
};

/**
 * 受け取った最新のスナップショット。
 *
 * WHY: このファイルはインスタンスが作られるたびに評価し直される。一方で画面を
 * 出すのは最初に登録したコピーだけ（ドックは同じ id なら先に登録したものを使う）
 * なので、状態を window に置いて全部のコピーで共有する。そうしないと、後から
 * 作られたコピーだけが新しい記録を受け取り、画面には出てこない。
 */
interface SharedState {
    latest: DecodedSnapshot | null;
    /** いま画面に出しているプレイ。切り替わったら控えを捨てる */
    playId: number | null;
    render: (() => void) | null;
    attached: WeakSet<GameContentLike>;
}

const shared: SharedState = ((): SharedState => {
    const host = window as unknown as {
        __akashicScoreboardServe?: SharedState;
    };
    return (host.__akashicScoreboardServe ??= {
        latest: null,
        playId: null,
        render: null,
        attached: new WeakSet<GameContentLike>(),
    });
})();

let body: HTMLElement | null = null;
let overlay: HTMLElement | null = null;

const handle = getDock().register({
    id: "scoreboard",
    label: "スコアボード",
    heading: "スコアボード（実行基盤の代役）",
    // WHY: ドックのパネルは狭く、記録は縦に伸びる。タブを開いたら画面全体を覆う
    // 表示に切り替え、パネル自体には案内だけを残す
    build: () => {
        shared.render = render;
        openOverlay();
        return create(
            "div",
            { fontSize: "12px", opacity: "0.7" },
            {
                textContent: "記録を全画面で表示しています。",
            },
        );
    },
    onClose: () => closeOverlay(),
});

function openOverlay(): void {
    if (overlay) {
        return;
    }
    overlay = create("div", {
        position: "fixed",
        inset: "0",
        zIndex: "10000",
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        boxSizing: "border-box",
    });
    const panel = create("div", {
        background: "#fff",
        color: "#222",
        borderRadius: "8px",
        width: "min(960px, 100%)",
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.35)",
        font: '14px/1.7 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif',
    });
    const header = create("div", {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "16px 20px",
        borderBottom: "1px solid #e3e3e3",
    });
    header.appendChild(
        create(
            "div",
            { fontSize: "16px", fontWeight: "600" },
            {
                textContent: "スコアボードの記録",
            },
        ),
    );
    const close = button("閉じる", false);
    close.onclick = () => handle.close();
    header.appendChild(close);
    body = create("div", {
        padding: "8px 20px 20px",
        overflowY: "auto",
    });
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    // WHY: 背景を押しても閉じられるほうが、ゲームへ戻る動作として自然
    overlay.onclick = (ev) => {
        if (ev.target === overlay) {
            handle.close();
        }
    };
    document.body.appendChild(overlay);
    render();
}

function closeOverlay(): void {
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    body = null;
    // WHY: 開き直したときは中身が無いので、同じ内容でも描き直す
    renderedMark = null;
}

let renderedMark: string | null = null;

/**
 * WHY: seq はプレイごとに 1 から振り直される。番号だけで見分けると、プレイを
 * 切り替えた直後の 1 件目が「描画済み」と同じ番号になり、画面が前のプレイの
 * ままになる。
 */
function markOf(latest: DecodedSnapshot): string {
    return `${latest.playId}:${latest.seq}`;
}

function render(): void {
    if (!body) {
        return;
    }
    const latest = shared.latest;
    // WHY: 同じ内容で描き直すと、スクロール位置と選択が飛ぶ
    if (latest && markOf(latest) === renderedMark) {
        return;
    }
    renderedMark = latest ? markOf(latest) : null;
    const snapshot: RecordSnapshot = latest
        ? latest.records
        : { play: {}, players: {} };
    body.textContent = "";
    body.appendChild(status(latest));
    body.appendChild(section("プレイ自体の記録", snapshot.play));
    const ids = Object.keys(snapshot.players);
    if (ids.length === 0) {
        body.appendChild(section("プレイヤーの記録", {}));
        return;
    }
    for (const id of ids) {
        body.appendChild(section(`プレイヤー ${id}`, snapshot.players[id]));
    }
}

/**
 * WHY: 画面が「いつの・どのプレイの」記録かを出す。送信が止まったときや、
 * 切り詰めて送ったときに、古い値を現在値として読まれないようにする。
 */
function status(latest: DecodedSnapshot | null): HTMLElement {
    const wrapper = create("div", {
        fontSize: "12px",
        opacity: "0.7",
        marginTop: "12px",
    });
    if (!latest) {
        wrapper.textContent = "まだ記録を受け取っていません。";
        return wrapper;
    }
    const time = new Date(latest.at).toLocaleTimeString();
    const play = latest.playId == null ? "不明" : String(latest.playId);
    wrapper.textContent = `最終更新 ${time} ／ プレイ ${play}`;
    if (latest.truncated) {
        wrapper.appendChild(
            create(
                "div",
                { color: "#a4471c" },
                {
                    // WHY: 落とすのはプレイヤーだけではない。プレイ自体の記録だけが
                    // 欠けている場合もあるので、どちらとも読める言い方にする
                    textContent:
                        "記録が大きいため、一部の記録を表示していません（プレイ自体の記録を含みます）。" +
                        "何を落としたかは akashic serve のコンソールに出ています。",
                },
            ),
        );
    }
    return wrapper;
}

function section(
    title: string,
    record: { [key: string]: unknown },
): HTMLElement {
    const wrapper = create("div", { marginTop: "16px" });
    wrapper.appendChild(
        create(
            "div",
            { fontSize: "13px", fontWeight: "600" },
            {
                textContent: title,
            },
        ),
    );
    const keys = Object.keys(record);
    if (keys.length === 0) {
        wrapper.appendChild(
            create(
                "div",
                { fontSize: "13px", opacity: "0.6" },
                {
                    textContent: "まだ記録がありません",
                },
            ),
        );
        return wrapper;
    }
    const table = create("table", {
        borderCollapse: "collapse",
        width: "100%",
        marginTop: "4px",
    });
    for (const key of keys) {
        const row = create("tr", {});
        row.appendChild(
            create(
                "th",
                {
                    textAlign: "left",
                    padding: "5px 10px 5px 0",
                    borderBottom: "1px solid #eee",
                    fontSize: "12px",
                    fontWeight: "600",
                    whiteSpace: "nowrap",
                    opacity: "0.75",
                },
                { textContent: key },
            ),
        );
        row.appendChild(
            create(
                "td",
                {
                    padding: "5px 0",
                    borderBottom: "1px solid #eee",
                    fontVariantNumeric: "tabular-nums",
                    overflowWrap: "anywhere",
                },
                { textContent: JSON.stringify(record[key]) },
            ),
        );
        table.appendChild(row);
    }
    wrapper.appendChild(table);
    return wrapper;
}

function accept(decoded: DecodedSnapshot): void {
    // WHY: 別のプレイ宛のスナップショットは出さない。古いプレイの再送が届いても、
    // いま開いているプレイの記録として読まれないようにする
    if (
        shared.playId != null &&
        decoded.playId != null &&
        decoded.playId !== shared.playId
    ) {
        return;
    }
    // WHY: 到着が入れ替わっても、古い内容で新しい内容を上書きしない
    const latest = shared.latest;
    if (
        latest &&
        latest.playId === decoded.playId &&
        latest.seq > decoded.seq
    ) {
        return;
    }
    shared.latest = decoded;
    if (shared.render) {
        shared.render();
    }
}

/**
 * WHY: ティックは instance ごとに流れる。インスタンスは作り直されるので、
 * 取りこぼさないよう新しい gameContent を見つけたら繋ぎ直す。同じものへ二重に
 * 繋がないよう、繋いだ相手を覚えておく（覚え先は全コピーで共有する）。
 */
function attach(): boolean {
    const content = serve()?.store?.currentLocalInstance?.gameContent;
    if (!content || !content.onTick) {
        return false;
    }
    // WHY: プレイが変わったら、前のプレイの記録を消す。新しいプレイがまだ
    // 何も記録していないときは拾い直しても何も来ないので、消さないと古い内容が
    // 残り続ける
    const playId = serve()?.store?.currentPlay?.playId ?? null;
    if (playId !== shared.playId) {
        shared.playId = playId;
        shared.latest = null;
        if (shared.render) {
            shared.render();
        }
    }
    if (shared.attached.has(content)) {
        return true;
    }
    shared.attached.add(content);
    content.onTick.add((arg) => {
        if (!arg || !arg.events) {
            return;
        }
        for (const event of arg.events) {
            const decoded = decodeSnapshot(event);
            if (decoded) {
                accept(decoded);
            }
        }
    });
    // WHY: onTick は繋いだ後のティックしか見えない。繋ぐ前に流れた分を
    // playlog から拾い直さないと、次の記録が来るまで画面が古いままになる
    recover();
    return true;
}

/** いまのプレイの playlog から、最後のスナップショットを拾い直す */
function recover(): void {
    const playId = serve()?.store?.currentPlay?.playId;
    if (playId == null || typeof fetch !== "function") {
        return;
    }
    fetch(`/api/plays/${playId}/playlog`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { data?: { tickList?: unknown } } | null) => {
            for (const event of collectEvents(body?.data)) {
                const decoded = decodeSnapshot(event);
                if (decoded) {
                    accept(decoded);
                }
            }
        })
        .catch(() => {
            // WHY: 拾い直せなくても、次の記録が来れば追いつく
        });
}

/**
 * WHY: playlog の形は cli-serve の内部の取り決めで、版によって変わりうる。
 * 深さを決め打ちせず、イベントらしい配列を拾って decodeSnapshot に判定させる。
 */
function collectEvents(value: unknown, depth = 0): unknown[] {
    if (!Array.isArray(value) || depth > 4) {
        return [];
    }
    if (typeof value[0] === "number" && value.length >= 4) {
        return [value];
    }
    const found: unknown[] = [];
    for (const child of value) {
        for (const event of collectEvents(child, depth + 1)) {
            found.push(event);
        }
    }
    return found;
}

// WHY: 画面を持っているのは最初に登録したコピーだけ。後から評価された
// コピーで上書きすると、描き直しが誰にも届かなくなる
shared.render ??= render;
if (!attach()) {
    // WHY: gameContent がまだ無いときだけ待つ。繋がったらタイマーを止める
    const timer = setInterval(() => {
        if (attach()) {
            clearInterval(timer);
        }
    }, 200);
}

// WHY: akashic serve は module.exports を 2 段で呼び、戻り値を
// g.game.external.<名前> に入れる。このプラグインの仕事は画面を出すことなので、
// コンテンツへ渡すものは持たない（ブラウザ側は passive で、記録は登録されない）
export default () => ({});
