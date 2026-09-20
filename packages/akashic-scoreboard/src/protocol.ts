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
    /**
     * 1プレイヤーあたりのキー数。1回の報告ではなく、**そのプレイで積み上がった
     * 記録全体**に掛かる。
     */
    keysPerPlayer?: number;
    /** string の長さ（コードポイント数） */
    stringLength?: number;
    /**
     * playerId の長さ（UTF-16 の符号単位）。
     *
     * WHY: playerId はコンテンツが決めた文字列で、実行基盤は受け取るまで中身を
     * 知らない。長さを見ないと、巨大な文字列を相手ごとの控えに積まれてしまう。
     */
    playerIdLength?: number;
    /**
     * 1プレイで記録を持てる相手の数。プレイ自体の記録を 1 つとして数える。
     *
     * WHY: 相手が増えるぶんには参加者の実数で頭打ちになるはずだが、コンテンツが
     * 申告する playerId は実在の参加者と結びついている保証がない。
     */
    subjectsPerPlay?: number;
}

/**
 * 上限が指定されなかったときの既定値。
 *
 * WHY: キー名の形式と値の型は上書きさせない。系列（同じキーの記録の連なり）の
 * 同一性が崩れると、後から集計を組み直せなくなるため。
 *
 * WHY: 凍結するのは、書き換えられると上限を渡さない実行基盤の防御が丸ごと
 * 外れるため。
 */
export const DEFAULT_LIMITS: Required<ScoreboardLimits> = Object.freeze({
    keysPerPlayer: 100,
    stringLength: 140,
    playerIdLength: 64,
    subjectsPerPlay: 1000,
});

/**
 * 実行基盤が渡してきた上限を読む。
 *
 * WHY: `NaN` や負の値をそのまま採ると、比較が常に偽になって上限が黙って
 * 消える。壊れた指定は既定値へ落とす。
 */
export function readLimit(
    limits: ScoreboardLimits | undefined,
    name: keyof ScoreboardLimits,
): number {
    const value = limits ? limits[name] : undefined;
    if (typeof value === "number" && isFinite(value) && value >= 0) {
        return value;
    }
    return DEFAULT_LIMITS[name];
}

/**
 * キー名の形式。半角英数字と `_` `-` `:` を 1〜32 文字。
 *
 * WHY: 記録は `(ゲーム, キー名)` で同一性を持つ。空白や全角文字を許すと、
 * 見た目が同じで別物のキーが生まれ、系列が分かれてしまう。文字種を絞るのは
 * それを避けるため。位置による制約は置かない。
 */
export const RECORD_KEY_PATTERN = /^[a-zA-Z0-9_:-]{1,32}$/;

/**
 * 形式には合うが使えないキー名。
 *
 * WHY: `__proto__` への代入は、素のオブジェクトではプロパティを作らずに
 * プロトタイプを差し替えようとする。受理したのに記録には載らない、という
 * 食い違いが生まれるうえ、記録を組み立てる側の足もとを崩す。
 */
const RESERVED_RECORD_KEYS = ["__proto__"];

/** 値が破棄された理由 */
export type DropReason =
    /** キー名が形式に合わない */
    | "InvalidKey"
    /** number / string / boolean 以外、または NaN・Infinity */
    | "InvalidValue"
    /** string が長すぎる */
    | "TooLong"
    /** キー数の上限を超えた */
    | "TooManyKeys"
    /** 記録を持てる相手の数の上限を超えた */
    | "TooManySubjects";

export interface DroppedEntry {
    /**
     * 破棄された値のキー名。
     *
     * **コンテンツが渡した文字列で、形式に合わない値もここに載る。**
     * 読める形にするため、制御文字は `?` に置き換え、長いものは切り詰めてある。
     */
    key: string;
    reason: DropReason;
}

/** `dropped` に積む上限。これを超えた分は数えるだけで捨てる */
const MAX_DROPPED_ENTRIES = 32;

/** `dropped` に載せるキー名の長さ */
const MAX_DROPPED_KEY_LENGTH = 64;

/**
 * 破棄したキー名を、控えたり記録に残したりしてよい形にする。
 *
 * WHY: キー名はコンテンツが決めた文字列で、形式に合わないものがここへ来る。
 * 長さも中身も制限が無いので、そのまま持つと巨大な文字列を抱え込むことになり、
 * 改行を混ぜられるとログの行を偽装される。
 */
function describeKey(key: string): string {
    let safe = "";
    for (let i = 0; i < key.length && i < MAX_DROPPED_KEY_LENGTH; i++) {
        const code = key.charCodeAt(i);
        safe += code < 0x20 || code === 0x7f ? "?" : key.charAt(i);
    }
    return key.length > MAX_DROPPED_KEY_LENGTH ? safe + "..." : safe;
}

function pushDropped(
    dropped: DroppedEntry[],
    key: string,
    reason: DropReason,
): void {
    if (dropped.length >= MAX_DROPPED_ENTRIES) {
        return;
    }
    dropped.push({ key: describeKey(key), reason: reason });
}

export interface NormalizeResult {
    record: ScoreRecordPatch;
    dropped: DroppedEntry[];
}

export function isValidRecordKey(key: string): boolean {
    if (RESERVED_RECORD_KEYS.indexOf(key) >= 0) {
        return false;
    }
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
 * `knownKeys` には、その相手について既に記録されているキーを渡す。キー数の
 * 上限は積み上がった記録全体に掛かるので、これを渡さないと 1 回の報告ぶんしか
 * 数えられない。既にあるキーの上書きは新しいキーとして数えない。
 *
 * WHY: 長すぎる string を切り詰めないのは、切り詰めた結果が別の値として
 * 集計されてしまうため。破棄するほうが読み手を誤らせない。
 */
export function normalizeRecordPatch(
    patch: unknown,
    limits?: ScoreboardLimits,
    knownKeys?: { [key: string]: true } | null,
): NormalizeResult {
    const record: ScoreRecordPatch = {};
    const dropped: DroppedEntry[] = [];
    if (!patch || typeof patch !== "object") {
        return { record: record, dropped: dropped };
    }
    const maxKeys = readLimit(limits, "keysPerPlayer");
    const maxLength = readLimit(limits, "stringLength");
    const source = patch as { [key: string]: unknown };
    // WHY: 値を読むのは 1 つにつき 1 回だけ。読むたびに違う値を返す getter を
    // 仕込まれると、数えたものと記録するものがずれて上限を越えられる
    const keys = Object.keys(source);
    const values: unknown[] = [];
    for (let i = 0; i < keys.length; i++) {
        values.push(source[keys[i]]);
    }
    const known = knownKeys ?? {};
    let count = Object.keys(known).length;
    // WHY: 同じ差分の中で消えるキーは、先に空きとして数える。後回しにすると、
    // 同じ内容の差分でもキーの並び順で結果が変わる
    for (let i = 0; i < keys.length; i++) {
        if (
            values[i] === null &&
            known[keys[i]] === true &&
            isValidRecordKey(keys[i])
        ) {
            count--;
        }
    }
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = values[i];
        if (!isValidRecordKey(key)) {
            pushDropped(dropped, key, "InvalidKey");
            continue;
        }
        // null はキーの削除を表すので、値の検証を通さずそのまま渡す。
        // 消す側が上限で弾かれると、上限に達した記録から抜け出せなくなる
        if (value === null) {
            record[key] = null;
            continue;
        }
        // 既にあるキーへの上書きは記録を増やさないので、上限には数えない
        if (known[key] !== true && count >= maxKeys) {
            pushDropped(dropped, key, "TooManyKeys");
            continue;
        }
        const type = typeof value;
        if (type === "number") {
            if (!isFinite(value as number)) {
                pushDropped(dropped, key, "InvalidValue");
                continue;
            }
        } else if (type === "string") {
            if (countCodePoints(value as string) > maxLength) {
                pushDropped(dropped, key, "TooLong");
                continue;
            }
        } else if (type !== "boolean") {
            pushDropped(dropped, key, "InvalidValue");
            continue;
        }
        record[key] = value as ScoreValue;
        if (known[key] !== true) {
            count++;
        }
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
