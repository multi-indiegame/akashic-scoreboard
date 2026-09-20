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
export const SNAPSHOT_VERSION = 2;

export type RecordValue = number | string | boolean;

export interface RecordSnapshot {
    play: { [key: string]: RecordValue };
    players: { [playerId: string]: { [key: string]: RecordValue } };
}

export interface SnapshotPayload {
    type: string;
    version: number;
    /** どのプレイの記録か。解決できなかったときは null */
    playId: number | null;
    /** 送った順。受け取る側は古い番号を捨てる */
    seq: number;
    /** 送った時刻（ミリ秒） */
    at: number;
    /** 大きすぎて一部のプレイヤーを落としたか */
    truncated: boolean;
    records: RecordSnapshot;
}

export interface DecodedSnapshot {
    playId: number | null;
    seq: number;
    at: number;
    truncated: boolean;
    records: RecordSnapshot;
}

export function buildPayload(
    records: RecordSnapshot,
    playId: number | null,
    seq: number,
    truncated: boolean,
): SnapshotPayload {
    return {
        type: SNAPSHOT_TYPE,
        version: SNAPSHOT_VERSION,
        playId: playId,
        seq: seq,
        at: Date.now(),
        truncated: truncated,
        records: records,
    };
}

/**
 * 受け取ったイベントが自分宛のスナップショットかを判定する。宛先違い・版違いは null。
 *
 * WHY: 形を検めてから返す。送り手は自分だけのはずだが、版の食い違いや他の拡張の
 * 事故で違う形が来たとき、壊れた表を出すより何も出さないほうがよい。
 */
export function decodeSnapshot(event: unknown): DecodedSnapshot | null {
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
    if (!records || typeof records !== "object" || Array.isArray(records)) {
        return null;
    }
    const players: RecordSnapshot["players"] = {};
    const source = asObject(records.players);
    for (const id of Object.keys(source)) {
        const record = asRecord(source[id]);
        if (record) {
            players[id] = record;
        }
    }
    return {
        playId: typeof data.playId === "number" ? data.playId : null,
        seq: typeof data.seq === "number" ? data.seq : 0,
        at: typeof data.at === "number" ? data.at : 0,
        truncated: data.truncated === true,
        records: { play: asRecord(records.play) ?? {}, players: players },
    };
}

function asObject(value: unknown): { [key: string]: unknown } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as { [key: string]: unknown };
}

function asRecord(value: unknown): { [key: string]: RecordValue } | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const record: { [key: string]: RecordValue } = {};
    const source = value as { [key: string]: unknown };
    for (const key of Object.keys(source)) {
        const entry = source[key];
        const type = typeof entry;
        if (type === "number" || type === "string" || type === "boolean") {
            record[key] = entry as RecordValue;
        }
    }
    return record;
}
