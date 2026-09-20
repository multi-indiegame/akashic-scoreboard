/**
 * サーバ側とブラウザ側で共有する、動作確認用の通り道の取り決め。
 *
 * WHY: **これはこの拡張の仕様ではない。** akashic-scoreboard は実行基盤から
 * コンテンツへの通知を定めない拡張なので、type にはこの serve パッケージの名前を
 * 使い、拡張本体の名前は使わない。レジストリ（PROTOCOL.md 9 章）で
 * 「通知を定めない」と書いていることと食い違わせないため。
 *
 * WHY: g にも DOM にも Node にも触れない。ブラウザ側のバンドルに Node の
 * モジュールを引き込まないよう、定数だけをこのファイルに置く。
 */

/** PROTOCOL.md 3.1 の予約 playerId */
export const RESERVED_PLAYER_ID = ":multi-indiegame";

/** playlog.EventCode.Message */
export const EVENT_CODE_MESSAGE = 32;

export const SNAPSHOT_TYPE = "@multi-indiegame/akashic-scoreboard-serve";
export const SNAPSHOT_VERSION = 1;

export interface RecordSnapshot {
    play: { [key: string]: unknown };
    players: { [playerId: string]: { [key: string]: unknown } };
}

export interface SnapshotPayload {
    type: string;
    version: number;
    records: RecordSnapshot;
}

/**
 * 受け取ったイベントが自分宛のスナップショットかを判定する。宛先違い・版違いは null。
 */
export function decodeSnapshot(event: unknown): RecordSnapshot | null {
    if (!Array.isArray(event) || event[0] !== EVENT_CODE_MESSAGE) {
        return null;
    }
    if (event[2] !== RESERVED_PLAYER_ID) {
        return null;
    }
    const data = event[3] as SnapshotPayload | undefined;
    if (!data || typeof data !== "object") {
        return null;
    }
    if (data.type !== SNAPSHOT_TYPE || data.version !== SNAPSHOT_VERSION) {
        return null;
    }
    const records = data.records;
    if (!records || typeof records !== "object") {
        return null;
    }
    return {
        play: records.play ?? {},
        players: records.players ?? {},
    };
}
