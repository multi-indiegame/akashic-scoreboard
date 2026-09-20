/**
 * g にも DOM にも触れない層。コンテンツ側パッケージと実行基盤向けパッケージの
 * 双方がこのファイルだけを共有する。
 *
 * 仕様: https://github.com/multi-indiegame/akashic-external-protocol/blob/main/PROTOCOL.md
 */

/** `g.game.external` 上のキー */
export const EXTERNAL_KEY = "scoreboard";

/** 記録に載せられる値 */
export type ScoreValue = number | string | boolean;

/**
 * 記録への差分。同じキーを後から書くと上書きされ、null を渡すとそのキーを消す。
 *
 * WHY: 差分として渡すのは、コンテンツが記録の全体像を持ち回らずに済むようにする
 * ため。まとめ方（マージ）は受け取る側が行う。
 */
export interface ScoreRecordPatch {
    [key: string]: ScoreValue | null;
}

/**
 * 実行基盤が課す上限。
 *
 * **上限を決めるのは実行基盤**で、ここにある既定値は「何も指定されなかったときに
 * 無尽蔵に保存しないための防御」でしかない。実行基盤が external 越しに渡してきた
 * ときはそちらに従う。緩める方向にも厳しくする方向にも指定できる。
 */
export interface ScoreboardLimits {
    /** 1プレイヤーあたりのキー数 */
    keysPerPlayer?: number;
    /** string の長さ（コードポイント数） */
    stringLength?: number;
    /**
     * 1回の報告に載るプレイヤー数。既定は無制限。
     *
     * WHY: 報告に載るのはアクティブインスタンスが把握している参加者なので、
     * 参加者数を超えては増えない。記録が漏れる害のほうが大きいため既定では絞らない。
     */
    playersPerReport?: number;
}

/**
 * 上限が指定されなかったときの既定値。
 *
 * WHY: キー名の形式と値の型は上書きさせない。系列（同じキーの記録の連なり）の
 * 同一性が崩れると、後から集計を組み直せなくなるため。
 */
export const DEFAULT_LIMITS: Required<
    Pick<ScoreboardLimits, "keysPerPlayer" | "stringLength">
> = {
    keysPerPlayer: 100,
    stringLength: 140,
};

/**
 * キー名の形式。半角英数字と `_` `-` `:` を 1〜32 文字。
 *
 * WHY: 記録は `(ゲーム, キー名)` で同一性を持つ。空白や全角文字を許すと、
 * 見た目が同じで別物のキーが生まれ、系列が分かれてしまう。文字種を絞るのは
 * それを避けるため。位置による制約は置かない。
 */
export const RECORD_KEY_PATTERN = /^[a-zA-Z0-9_:-]{1,32}$/;

/** 値が破棄された理由 */
export type DropReason =
    /** キー名が形式に合わない */
    | "InvalidKey"
    /** number / string / boolean 以外、または NaN・Infinity */
    | "InvalidValue"
    /** string が長すぎる */
    | "TooLong"
    /** キー数の上限を超えた */
    | "TooManyKeys";

export interface DroppedEntry {
    key: string;
    reason: DropReason;
}

export interface NormalizeResult {
    record: ScoreRecordPatch;
    dropped: DroppedEntry[];
}

export function isValidRecordKey(key: string): boolean {
    return RECORD_KEY_PATTERN.test(key);
}

/**
 * 記録の差分を、渡してよい形に揃える。
 *
 * 揃うのは形だけで、**最終的な判定は受け取る側が行う**（PROTOCOL.md 8 章）。
 * ライブラリ側でも通すのは、誤りに早く気づけるようにするため。
 *
 * 既定外のため破棄した値は握り潰さず `dropped` に積んで返す。投稿者の動作確認に支障が出るので警告を出す。
 *
 * WHY: 長すぎる string を切り詰めないのは、切り詰めた結果が別の値として
 * 集計されてしまうため。破棄するほうが読み手を誤らせない。
 */
export function normalizeRecordPatch(
    patch: unknown,
    limits?: ScoreboardLimits,
): NormalizeResult {
    const record: ScoreRecordPatch = {};
    const dropped: DroppedEntry[] = [];
    if (!patch || typeof patch !== "object") {
        return { record: record, dropped: dropped };
    }
    const maxKeys =
        limits && typeof limits.keysPerPlayer === "number"
            ? limits.keysPerPlayer
            : DEFAULT_LIMITS.keysPerPlayer;
    const maxLength =
        limits && typeof limits.stringLength === "number"
            ? limits.stringLength
            : DEFAULT_LIMITS.stringLength;
    const source = patch as { [key: string]: unknown };
    let count = 0;
    for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) {
            continue;
        }
        if (!isValidRecordKey(key)) {
            dropped.push({ key: key, reason: "InvalidKey" });
            continue;
        }
        if (count >= maxKeys) {
            dropped.push({ key: key, reason: "TooManyKeys" });
            continue;
        }
        const value = source[key];
        // null はキーの削除を表すので、値の検証を通さずそのまま渡す
        if (value === null) {
            record[key] = null;
            count++;
            continue;
        }
        const type = typeof value;
        if (type === "number") {
            if (!isFinite(value as number)) {
                dropped.push({ key: key, reason: "InvalidValue" });
                continue;
            }
        } else if (type === "string") {
            if (countCodePoints(value as string) > maxLength) {
                dropped.push({ key: key, reason: "TooLong" });
                continue;
            }
        } else if (type !== "boolean") {
            dropped.push({ key: key, reason: "InvalidValue" });
            continue;
        }
        record[key] = value as ScoreValue;
        count++;
    }
    return { record: record, dropped: dropped };
}

/**
 * WHY: `String#length` は UTF-16 の符号単位を数えるので、絵文字や一部の漢字が
 * 2文字として数えられる。書いた人の感覚に合う長さで判定する。
 */
function countCodePoints(value: string): number {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        // サロゲートペアの後半は前半と合わせて1文字として数える
        if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
            const prev = value.charCodeAt(i - 1);
            if (prev >= 0xd800 && prev <= 0xdbff) {
                continue;
            }
        }
        count++;
    }
    return count;
}

/**
 * `g.game.external.scoreboard` に生えるオブジェクト。
 *
 * WHY: 結果を返す口を置かない。報告が通るのはアクティブインスタンスだけで、
 * そこに UI は無いと考えてよいため、結果を知らせる相手がいない。
 */
export interface ScoreboardExternal {
    setPlayerRecord: (playerId: string, patch: ScoreRecordPatch) => void;
    setPlayRecord: (patch: ScoreRecordPatch) => void;
    /** 実行基盤が課す上限。渡ってこなければ既定値を使う */
    limits?: ScoreboardLimits;
}

export interface FunctionSignature {
    type: "function";
    callbackProp: string | null;
}

export interface ObjectSignature {
    type: "object";
    content: { [key: string]: FunctionSignature | ObjectSignature };
}

/**
 * `untrusted: true` の実行基盤で関数呼び出しを橋渡しするためのメタデータ。
 *
 * WHY: 実行基盤ごとに書き起こすと、引数の位置がずれても気づけない。プロトコルの
 * 一部としてここで固定する。
 *
 * この拡張は結果を返さないので callbackProp は無い。`limits` は関数ではないため
 * 橋渡しの対象外で、渡らない実行基盤では既定値が使われる（最終的な判定は
 * どのみち受け取る側が行う）。
 */
export const UNTRUSTED_SIGNATURE: ObjectSignature = {
    type: "object",
    content: {
        setPlayerRecord: { type: "function", callbackProp: null },
        setPlayRecord: { type: "function", callbackProp: null },
    },
};
