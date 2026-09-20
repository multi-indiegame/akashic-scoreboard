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
    SNAPSHOT_TYPE,
    SNAPSHOT_VERSION,
} from "./channel";

/** 任意の play へ流す。playId を知らなくて済むよう latest を使う */
const PATH = "/api/public/v1/plays/latest/playlog";

export interface ServeOrigin {
    protocol: string;
    hostname: string;
    port: number;
}

let warned = false;

/**
 * いまの記録の全体を 1 件のイベントとして流す。
 *
 * WHY: 差分ではなく全体を送る。受け取る側がマージを持たずに済み、取りこぼしが
 * あっても次の 1 件で追いつく。動作確認用なので、量より確実さを取る。
 */
export function sendSnapshot(origin: ServeOrigin, snapshot: unknown): void {
    const body = JSON.stringify({
        events: [
            [
                EVENT_CODE_MESSAGE,
                0,
                RESERVED_PLAYER_ID,
                {
                    type: SNAPSHOT_TYPE,
                    version: SNAPSHOT_VERSION,
                    records: snapshot,
                },
            ],
        ],
    });
    const client = origin.protocol === "https" ? https : http;
    const req = client.request(
        {
            host: origin.hostname,
            port: origin.port,
            path: PATH,
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
            },
        },
        (res) => {
            // WHY: 読み捨てないと socket が解放されない
            res.resume();
            if (res.statusCode !== 200) {
                warnOnce(
                    `akashic serve の playlog API が ${res.statusCode} を返しました`,
                );
            }
        },
    );
    req.on("error", (err) => {
        warnOnce(`akashic serve へ記録を送れませんでした: ${err.message}`);
    });
    req.end(body);
}

/**
 * WHY: 記録が登録されるたびに同じ失敗を出すとコンソールが埋まる。動作確認の妨げに
 * なるので一度だけにする。
 */
function warnOnce(message: string): void {
    if (warned) {
        return;
    }
    warned = true;
    console.warn(`[akashic-scoreboard-serve] ${message}`);
}
