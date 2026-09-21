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

/** 応答を待つ時間 */
const REQUEST_TIMEOUT_MS = 5000;

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
/** プレイの解決をやり直す回数と間隔 */
const RESOLVE_ATTEMPTS = 3;
const RESOLVE_RETRY_MS = 500;

export class SnapshotSender {
    _origin: ServeOrigin;
    _playId: number | null = null;
    _resolved = false;
    /**
     * このバックエンドが作られた時刻。
     *
     * WHY: 自分のプレイを見分けるのに使う。`server.external` は playId を
     * 渡してくれないが、プレイはランナーより先に作られるので、**この時刻より
     * 前に作られたプレイのうち最新**が自分のプレイになる。
     */
    _bornAt = Date.now();
    _attempts = 0;
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
        // WHY: 後始末は一度だけ。タイムアウトと error が続けて起きても、
        // _inFlight を戻すのと再送の予約が二重にならないようにする
        let settled = false;
        const settle = (reason: string | null, message?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            this._inFlight = false;
            if (reason == null) {
                this._flush();
                return;
            }
            this._warn(reason, message ?? reason);
            this._retryLater(snapshot);
        };
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
                if (res.statusCode === 200) {
                    settle(null);
                    return;
                }
                settle(
                    `status:${res.statusCode}`,
                    `akashic serve の playlog API が ${res.statusCode} を返しました` +
                        `（送信量 ${Buffer.byteLength(body)} バイト）。画面の記録が古いままになります`,
                );
            },
        );
        req.on("error", (err) => {
            settle(
                `error:${err.message}`,
                `akashic serve へ記録を送れませんでした: ${err.message}`,
            );
        });
        // WHY: 接続はできるのに応答が返らない相手だと、応答も error も起きない。
        // 打ち切らないと送信中のまま固まり、以後の記録が画面に出なくなる
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            settle(
                "timeout",
                `akashic serve から応答がありません（${REQUEST_TIMEOUT_MS} ミリ秒）。` +
                    "送信先が合っているか確かめてください",
            );
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
        // WHY: プレイ自体の記録も対象にする。上限を大きくした構成では、これだけで
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
                    ? `、プレイ自体の記録 ${Object.keys(play).length} / ${playKeys} 件`
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
        this._attempts++;
        const client = this._origin.protocol === "https" ? https : http;
        // WHY: 後始末は一度だけ。打ち切ったあとに error も続くので、そのままだと
        // 1 回の失敗でやり直しが 2 本走り、試行回数を食い潰す
        let settled = false;
        const settle = (text: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (text != null) {
                this._playId = ownPlayId(text, this._bornAt);
            }
            this._done();
        };
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
                res.on("end", () => settle(text));
            },
        );
        req.on("error", () => settle(null));
        req.setTimeout(2000, () => {
            req.destroy();
            settle(null);
        });
        req.end();
    }

    _done(): void {
        if (this._resolved) {
            return;
        }
        // WHY: 決められないまま送ると、プレイが 2 つ以上あるときに他のプレイの
        // 画面へ流れ込む。何度か試してから諦める
        if (this._playId == null && this._attempts < RESOLVE_ATTEMPTS) {
            const timer = setTimeout(
                () => this._resolvePlayId(),
                RESOLVE_RETRY_MS,
            );
            timer.unref();
            return;
        }
        this._resolved = true;
        if (this._playId == null) {
            this._warn(
                "unresolved-play",
                "どのプレイの記録かを決められませんでした。" +
                    "最新のプレイへ送るので、複数のプレイを開いていると記録が混ざります",
            );
        }
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

/**
 * 自分のプレイを選ぶ。
 *
 * WHY: 単に最新のプレイを採ると、この問い合わせが返るまでに次のプレイが
 * 作られたとき、そちらを自分のプレイだと思い込む。作られた時刻で絞る。
 *
 * 同じミリ秒に 2 つのプレイが作られた場合は見分けられない。`server.external`
 * には playId が渡らないので、ここが限界。
 */
function ownPlayId(text: string, bornAt: number): number | null {
    try {
        const body = JSON.parse(text) as {
            data?: { playId?: unknown; createdAt?: unknown }[];
        };
        const plays = body.data;
        if (!Array.isArray(plays)) {
            return null;
        }
        let found: { id: number; createdAt: number } | null = null;
        for (const play of plays) {
            const id = Number(play?.playId);
            const createdAt = Number(play?.createdAt);
            if (!Number.isFinite(id) || !Number.isFinite(createdAt)) {
                continue;
            }
            if (createdAt > bornAt) {
                continue;
            }
            if (
                !found ||
                createdAt > found.createdAt ||
                (createdAt === found.createdAt && id > found.id)
            ) {
                found = { id: id, createdAt: createdAt };
            }
        }
        return found ? found.id : null;
    } catch (_err) {
        return null;
    }
}
