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

/** playlog.EventCode.Operation */
export const EVENT_CODE_OPERATION = 64;

/**
 * スナップショットを載せる playlog イベントの種別。
 *
 * - `message`: MessageEvent で運ぶ（既定）
 * - `operation`: OperationEvent で運ぶ
 *
 * WHY: coe (@akashic-extension/coe) の Scene は**届いた g.MessageEvent を
 * すべて握りつぶす**（Scene の JSDoc にも明記されている）。アクティブ
 * インスタンスのイベントフィルタで消えるため、ティックにも playlog の
 * ダンプにも現れず、coe コンテンツでは画面が永久に空のままになる。coe の
 * フィルタが落とすのは 0x20 だけで、それ以外の種別は素通しする。
 *
 * WHY: 既定を差し替えないのは、OperationEvent が本来**操作プラグインのための
 * 種別**だから。コンテンツが game.json の `operationPlugins` で宣言した code の
 * 操作を、コンテンツ自身が受け取る、という往復が前提にある。こちらは code を
 * 宣言せずに占有し、読むのもコンテンツではなくブラウザ側の道具なので、本来の
 * 使い方からは外れている。coe のために避けられないときだけ使う。
 */
export type SnapshotTransport = "message" | "operation";

/**
 * OperationEvent で運ぶときの操作プラグインコードの既定値。
 *
 * WHY: code には予約の仕組みが無く、コンテンツが `akashic install -p <code>` で
 * 好きな番号を宣言できる。慣習的に使われる小さい番号を避けて大きい値を選ぶ。
 * 0x6d69 は "mi"（multi-indiegame）。それでも衝突する相手はいるので、利用者が
 * 番号を差し替えられるようにしてある。
 *
 * WHY: 受け取る側はこの番号では判定しない（playerId と type で判定する）。
 * だから番号を変えてもブラウザ側は直さずに済む。
 */
export const DEFAULT_SNAPSHOT_OPERATION_CODE = 0x6d69;

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
    /** 大きすぎて一部のプレイヤーを破棄したか */
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
 * スナップショットを playlog のイベントに仕立てる。
 *
 * WHY: 種別が 2 通りあるので、組み立てと読み取りを 1 つのファイルに並べて置く。
 * 片方だけ直すと、送ったのに画面に出ない、という気づきにくい壊れ方をする。
 */
export function encodeSnapshotEvent(
    payload: SnapshotPayload,
    transport: SnapshotTransport,
    operationCode: number = DEFAULT_SNAPSHOT_OPERATION_CODE,
): unknown[] {
    if (transport === "operation") {
        // [種別, フラグ, playerId, 操作プラグインコード, データ, ローカルか]
        return [
            EVENT_CODE_OPERATION,
            0,
            RESERVED_PLAYER_ID,
            operationCode,
            payload,
            false,
        ];
    }
    // [種別, フラグ, playerId, データ]
    return [EVENT_CODE_MESSAGE, 0, RESERVED_PLAYER_ID, payload];
}

/**
 * 受け取ったイベントが自分宛のスナップショットかを判定する。宛先違い・版違いは null。
 *
 * WHY: 形を検めてから返す。送り手は自分だけのはずだが、版の食い違いや他の拡張の
 * 事故で違う形が来たとき、壊れた表を出すより何も出さないほうがよい。
 *
 * WHY: 両方の種別を受ける。ブラウザ側のプラグインを 1 つで済ませるためで、
 * MessageEvent 版と OperationEvent 版のどちらのバックエンドを挿しても同じ画面が
 * 出る。どちらで来たかは画面に出す必要が無い。
 */
export function decodeSnapshot(event: unknown): DecodedSnapshot | null {
    if (!Array.isArray(event)) {
        return null;
    }
    const code = event[0];
    if (code !== EVENT_CODE_MESSAGE && code !== EVENT_CODE_OPERATION) {
        return null;
    }
    if (event[2] !== RESERVED_PLAYER_ID) {
        return null;
    }
    // WHY: OperationEvent では、データの前に操作プラグインコードが挟まる。
    // その番号自体は見ない（自分宛かどうかは下の type と版で分かる）
    const data = (code === EVENT_CODE_OPERATION ? event[4] : event[3]) as
        SnapshotPayload | undefined;
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
    // WHY: playerId はコンテンツが決めた文字列で、`__proto__` も来る。素の
    // オブジェクトへ代入すると、そのプレイヤーの記録がプロパティにならず、
    // 画面から消える
    const players: RecordSnapshot["players"] = Object.create(null);
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
    const record: { [key: string]: RecordValue } = Object.create(null);
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
