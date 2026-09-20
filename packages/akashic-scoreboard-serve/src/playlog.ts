/**
 * 記録を akashic serve の playlog へ流す。
 *
 * WHY: 記録が登録されるのは akashic serve の**サーバ側**（`server.external`）で、
 * 操作盤が動くブラウザ側からは見えない。cli-serve には `server.external` の
 * モジュールがブラウザへ送信する口が無いので、playlog を通り道にする。playlog に
 * 載ればパッシブインスタンスへ配られ、ブラウザ側のプラグインが拾える。
 *
 * WHY: これは**動作確認用の通り道**であって、この拡張の仕様ではない。
 * akashic-scoreboard は実行基盤からコンテンツへの通知を定めない拡張なので、
 * type にはこの serve パッケージの名前を使い、拡張本体の名前は使わない。
 */
import * as http from "http";
import * as https from "https";
import {
    EVENT_CODE_MESSAGE,
    RESERVED_PLAYER_ID,
    RecordSnapshot,
    buildPayload,
} from "./channel";

const PLAYS_PATH = "/api/plays";

/**
 * cli-serve の body parser は 100KB で弾く。そこに届く前に自分で切り詰める。
 *
 * WHY: 413 で弾かれると、記録は増える一方なので以後のスナップショットが
 * すべて落ちる。表示が止まったまま戻らなくなる。
 */
const MAX_BODY_BYTES = 80 * 1024;

/** 送信に失敗したときに、同じ内容をもう一度試すまでの間隔 */
const RETRY_MS = 3000;

/** 同じ理由の警告を出し直すまでの間隔 */
const WARN_INTERVAL_MS = 30 * 1000;

export interface ServeOrigin {
    protocol: string;
    hostname: string;
    port: number;
}

/**
 * スナップショットを playlog へ流す。
 *
 * WHY: 1 プレイにつき 1 つ作る。送り先のプレイを起動時に 1 回だけ決めるためで、
 * 複数のプレイを開いたときに他のプレイへ記録が混ざらないようにする。
 */
export class SnapshotSender {
    _origin: ServeOrigin;
    _playId: number | null = null;
    _resolved = false;
    _pending: RecordSnapshot | null = null;
    _inFlight = false;
    _seq = 0;
    _retry: NodeJS.Timeout | null = null;
    _warnedAt: { [reason: string]: number } = Object.create(null);

    constructor(origin: ServeOrigin) {
        this._origin = origin;
        this._resolvePlayId();
    }

    /**
     * いまの記録の全体を 1 件のイベントとして流す。
     *
     * WHY: 差分ではなく全体を送る。受け取る側がマージを持たずに済み、取りこぼしが
     * あっても次の 1 件で追いつく。動作確認用なので、量より確実さを取る。
     */
    send(snapshot: RecordSnapshot): void {
        this._pending = snapshot;
        this._flush();
    }

    _flush(): void {
        // WHY: 送信を重ねない。同時に投げると到着が入れ替わり、古い内容が
        // 後から playlog の末尾に残る
        if (this._inFlight || !this._pending || !this._resolved) {
            return;
        }
        const snapshot = this._pending;
        this._pending = null;
        this._inFlight = true;
        const body = this._buildBody(snapshot);
        const client = this._origin.protocol === "https" ? https : http;
        const path =
            this._playId == null
                ? "/api/public/v1/plays/latest/playlog"
                : `/api/public/v1/plays/${this._playId}/playlog`;
        const req = client.request(
            {
                host: this._origin.hostname,
                port: this._origin.port,
                path: path,
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                // WHY: 読み捨てないと socket が解放されない
                res.resume();
                this._inFlight = false;
                if (res.statusCode === 200) {
                    this._flush();
                    return;
                }
                this._warn(
                    `status:${res.statusCode}`,
                    `akashic serve の playlog API が ${res.statusCode} を返しました` +
                        `（送信量 ${Buffer.byteLength(body)} バイト）。画面の記録が古いままになります`,
                );
                this._retryLater(snapshot);
            },
        );
        req.on("error", (err) => {
            this._inFlight = false;
            this._warn(
                `error:${err.message}`,
                `akashic serve へ記録を送れませんでした: ${err.message}`,
            );
            this._retryLater(snapshot);
        });
        req.end(body);
    }

    /**
     * WHY: 失敗したまま次の記録を待つと、最後の 1 件が落ちたときに画面が
     * 古いまま止まる。新しい記録が来ていなければ同じ内容をもう一度試す。
     */
    _retryLater(snapshot: RecordSnapshot): void {
        if (this._retry) {
            return;
        }
        if (!this._pending) {
            this._pending = snapshot;
        }
        this._retry = setTimeout(() => {
            this._retry = null;
            this._flush();
        }, RETRY_MS);
        this._retry.unref();
    }

    _buildBody(snapshot: RecordSnapshot): string {
        const seq = ++this._seq;
        const full = wrap(buildPayload(snapshot, this._playId, seq, false));
        if (Buffer.byteLength(full) <= MAX_BODY_BYTES) {
            return full;
        }
        // WHY: 入るところまでを送る。全部落とすより、途中まででも見えるほうがよい
        const play: RecordSnapshot["play"] = {};
        const players: RecordSnapshot["players"] = Object.create(null);
        const base = { play: play, players: players };
        let used = Buffer.byteLength(
            wrap(buildPayload(base, this._playId, seq, true)),
        );
        // WHY: 部屋の記録も対象にする。上限を大きくした構成では、これだけで
        // 本文が上限を超えることがある。落とさずにいると 413 のまま戻らない
        for (const key of Object.keys(snapshot.play)) {
            const piece = sizeOf(key, snapshot.play[key]);
            if (used + piece > MAX_BODY_BYTES) {
                break;
            }
            play[key] = snapshot.play[key];
            used += piece;
        }
        for (const id of Object.keys(snapshot.players)) {
            const piece = sizeOf(id, snapshot.players[id]);
            if (used + piece > MAX_BODY_BYTES) {
                break;
            }
            players[id] = snapshot.players[id];
            used += piece;
        }
        const playKeys = Object.keys(snapshot.play).length;
        const droppedPlayKeys = playKeys - Object.keys(play).length;
        this._warn(
            "truncated",
            `記録が大きいため、一部を落として送りました` +
                `（プレイヤー ${Object.keys(players).length} / ${Object.keys(snapshot.players).length} 人` +
                (droppedPlayKeys > 0
                    ? `、部屋の記録 ${Object.keys(play).length} / ${playKeys} 件`
                    : "") +
                `）`,
        );
        return wrap(buildPayload(base, this._playId, seq, true));
    }

    /**
     * 自分がどのプレイに属するかを決める。
     *
     * WHY: `plays/latest` へ送ると、後から別のプレイが作られた瞬間に、こちらの
     * 記録がそちらの画面へ流れ込む。このモジュールはプレイごとに作られるので、
     * 作られた時点で最新のプレイが自分のプレイになる。
     */
    _resolvePlayId(): void {
        const client = this._origin.protocol === "https" ? https : http;
        const req = client.request(
            {
                host: this._origin.hostname,
                port: this._origin.port,
                path: PLAYS_PATH,
                method: "GET",
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => (text += chunk));
                res.on("end", () => {
                    this._playId = latestPlayId(text);
                    this._done();
                });
            },
        );
        req.on("error", () => this._done());
        // WHY: 待ち続けない。決められなければ latest へ送る（プレイが 1 つなら同じ）
        req.setTimeout(2000, () => {
            req.destroy();
            this._done();
        });
        req.end();
    }

    _done(): void {
        if (this._resolved) {
            return;
        }
        this._resolved = true;
        this._flush();
    }

    /**
     * WHY: 記録が登録されるたびに同じ失敗を出すとコンソールが埋まる。かといって
     * 一度きりだと、後から起きた別の失敗に気づけない。理由ごとに間隔を空けて出す。
     */
    _warn(reason: string, message: string): void {
        const now = Date.now();
        const last = this._warnedAt[reason];
        if (last != null && now - last < WARN_INTERVAL_MS) {
            return;
        }
        this._warnedAt[reason] = now;
        console.warn(`[akashic-scoreboard-serve] ${message}`);
    }
}

function sizeOf(key: string, value: unknown): number {
    return (
        Buffer.byteLength(JSON.stringify(key) + JSON.stringify(value ?? null)) +
        2
    );
}

function wrap(payload: unknown): string {
    return JSON.stringify({
        events: [[EVENT_CODE_MESSAGE, 0, RESERVED_PLAYER_ID, payload]],
    });
}

function latestPlayId(text: string): number | null {
    try {
        const body = JSON.parse(text) as { data?: { playId?: unknown }[] };
        const plays = body.data;
        if (!Array.isArray(plays)) {
            return null;
        }
        let latest: number | null = null;
        for (const play of plays) {
            const id = Number(play?.playId);
            if (Number.isFinite(id) && (latest == null || id > latest)) {
                latest = id;
            }
        }
        return latest;
    } catch (_err) {
        return null;
    }
}
