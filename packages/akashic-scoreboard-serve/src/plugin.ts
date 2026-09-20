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
import { decodeSnapshot, RecordSnapshot } from "./channel";

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
    } | null;
}

const serve = (): ServeGlobals | null => {
    const host = window as unknown as {
        akashicServe?: ServeGlobals;
        __testbed?: ServeGlobals;
    };
    return host.akashicServe ?? host.__testbed ?? null;
};

let snapshot: RecordSnapshot = { play: {}, players: {} };
let body: HTMLElement | null = null;
let overlay: HTMLElement | null = null;

const handle = getDock().register({
    id: "scoreboard",
    label: "スコアボード",
    heading: "スコアボード（実行基盤の代役）",
    // WHY: ドックのパネルは狭く、記録は縦に伸びる。タブを開いたら画面全体を覆う
    // 表示に切り替え、パネル自体には案内だけを残す
    build: () => {
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
}

function render(): void {
    if (!body) {
        return;
    }
    body.textContent = "";
    body.appendChild(section("部屋の記録", snapshot.play));
    const ids = Object.keys(snapshot.players);
    if (ids.length === 0) {
        body.appendChild(section("プレイヤーの記録", {}));
        return;
    }
    for (const id of ids) {
        body.appendChild(section(`プレイヤー ${id}`, snapshot.players[id]));
    }
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

/**
 * WHY: ティックは instance ごとに流れる。インスタンスは作り直されるので、
 * 取りこぼさないよう新しい gameContent を見つけたら繋ぎ直す。同じものへ二重に
 * 繋がないよう、繋いだ相手を覚えておく。
 */
const attached = new WeakSet<GameContentLike>();

function attach(): void {
    const content = serve()?.store?.currentLocalInstance?.gameContent;
    if (!content || !content.onTick || attached.has(content)) {
        return;
    }
    attached.add(content);
    content.onTick.add((arg) => {
        if (!arg || !arg.events) {
            return;
        }
        for (const event of arg.events) {
            const decoded = decodeSnapshot(event);
            if (decoded) {
                snapshot = decoded;
                render();
            }
        }
    });
}

attach();
setInterval(attach, 1000);

// WHY: akashic serve は module.exports を 2 段で呼び、戻り値を
// g.game.external.<名前> に入れる。このプラグインの仕事は画面を出すことなので、
// コンテンツへ渡すものは持たない（ブラウザ側は passive で、記録は登録されない）
export default () => ({});
