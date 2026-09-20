import {
    DroppedEntry,
    EXTERNAL_KEY,
    ScoreRecordPatch,
    ScoreboardExternal,
    normalizeRecordPatch,
} from "./protocol";

export {
    DEFAULT_LIMITS,
    DropReason,
    DroppedEntry,
    RECORD_KEY_PATTERN,
    ScoreValue,
    ScoreRecordPatch,
    ScoreboardLimits,
    isValidRecordKey,
    // WHY: サブパス (@multi-indiegame/akashic-scoreboard/protocol) は
    // package.json の exports 由来で、Akashic の g._require は exports を
    // 解釈しない。実行基盤アダプタが本体エントリだけで完結できるよう、
    // 検証もここから出す。
    normalizeRecordPatch,
} from "./protocol";

/*
 * WHY: lib に DOM を含めていないので console の型が無い。設定ミスを知らせる
 * 警告にだけ使うので、必要な形だけをここで宣言する。
 */
declare const console: { warn?: (...data: unknown[]) => void } | undefined;

function findExternal(): ScoreboardExternal | null {
    const external = g.game.external as { [key: string]: unknown } | undefined;
    if (!external) {
        return null;
    }
    const found = external[EXTERNAL_KEY] as ScoreboardExternal | undefined;
    if (
        !found ||
        typeof found.setPlayerRecord !== "function" ||
        typeof found.setPlayRecord !== "function"
    ) {
        return null;
    }
    return found;
}

/**
 * 報告源をアクティブインスタンスに限る。
 *
 * WHY: パッシブインスタンスの報告は手元で書き換えられる恐れがある。アクティブ
 * インスタンスはゲーム情報を集約して持っていると期待できるので、信頼できる
 * 情報源としてこちらだけを採る。**この判定はライブラリが持つ**ので、実行基盤が
 * external をどこに生やすかに関わらず指針が保たれる。
 */
function isActiveInstance(): boolean {
    const game = g.game as unknown as { isActiveInstance?: () => boolean };
    if (typeof game.isActiveInstance !== "function") {
        return false;
    }
    return game.isActiveInstance();
}

function canDetectActiveInstance(): boolean {
    const game = g.game as unknown as { isActiveInstance?: () => boolean };
    return typeof game.isActiveInstance === "function";
}

const _warnedKeys: string[] = [];

/**
 * 相手ごとに、これまで報告したキー。
 *
 * WHY: キー数の上限は積み上がった記録全体に掛かる。控えずに 1 回の報告ごとに
 * 数えると、既にあるキーへの上書きが「新しいキー」に見えて捨てられる。
 *
 * WHY: 素のオブジェクトにしないのは、playerId に `__proto__` のような名前が
 * 来たときに継承したプロパティへ当たるのを避けるため。
 */
const _sentKeys: { [subject: string]: { [key: string]: true } } =
    Object.create(null);

function sentKeysOf(subject: string): { [key: string]: true } {
    const known = _sentKeys[subject];
    if (known) {
        return known;
    }
    return (_sentKeys[subject] = Object.create(null) as {
        [key: string]: true;
    });
}

function remember(
    known: { [key: string]: true },
    record: ScoreRecordPatch,
): void {
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i++) {
        if (record[keys[i]] === null) {
            delete known[keys[i]];
        } else {
            known[keys[i]] = true;
        }
    }
}

/**
 * WHY: ライブラリが既定外の値を告知なしに破棄すると、投稿者の動作確認に支障が出るので警告する。
 * 同じキーで繰り返し警告しても新しい情報は無いので、キーごとに一度だけにする。
 */
function warnDropped(dropped: DroppedEntry[]): void {
    if (dropped.length === 0) {
        return;
    }
    if (typeof console === "undefined" || !console || !console.warn) {
        return;
    }
    for (let i = 0; i < dropped.length; i++) {
        const entry = dropped[i];
        const mark = entry.key + ":" + entry.reason;
        if (_warnedKeys.indexOf(mark) !== -1) {
            continue;
        }
        _warnedKeys.push(mark);
        console.warn(
            "[akashic-scoreboard] 既定外の値だったため、記録せずに破棄しました " +
                "(key: " +
                entry.key +
                ", reason: " +
                entry.reason +
                ")",
        );
    }
}

/**
 * このインスタンスから記録を登録できるか。
 *
 * **結果はローカル。** 同じ実行基盤の上でも、アクティブインスタンスでは true、
 * プレイヤーの画面では false ということがある。記録に関する表示を出すかどうかの
 * ようなローカルな判断にだけ使い、**ゲーム状態をこれで分岐させないこと**。
 *
 * WHY: 対応・非対応の両方の実行基盤に同じコンテンツを投稿するとき、非対応の
 * 実行基盤では意味を持たない表示を出したくない。
 */
export function isSupported(): boolean {
    return isActiveInstance() && findExternal() !== null;
}

/**
 * プレイヤーごとの記録を登録する。
 *
 * `playerId` は、そのプレイヤーについてコンテンツが観測している in-game playerId
 * （`ev.player.id` の値）を渡すこと。**それが誰かを決めるのは実行基盤**で、
 * ライブラリは文字列として渡すだけ。実行基盤が知らない playerId の記録は廃棄される。
 *
 * **アクティブインスタンスに通らない分岐の中に置くと登録されない。**
 * `g.game.selfId` の比較の中やローカルエンティティのハンドラ内がそれにあたる。
 * 登録される条件は「アクティブインスタンスで実行されること」だけで、全インスタンスで
 * 実行する必要はない。
 *
 * 結果は返らない。報告が通るのはアクティブインスタンスだけで、そこに結果を
 * 知らせる相手がいないため、呼んだら待たずに返る。
 *
 * 同じキーを後から書くと上書きされ、`null` を渡すとそのキーを消す。
 */
export function setPlayerRecord(
    playerId: string,
    patch: ScoreRecordPatch,
): void {
    if (typeof playerId !== "string" || playerId === "") {
        return;
    }
    const reported = report(patch, "player:" + playerId);
    if (!reported) {
        return;
    }
    reported.external.setPlayerRecord(playerId, reported.record);
    // WHY: 控えるのは報告したあと。実行基盤が例外を出した分を数に入れると、
    // 記録されていないキーで上限が埋まる
    remember(reported.known, reported.record);
}

/**
 * プレイヤーに紐づかない、プレイ自体に関する記録を登録する。
 *
 * 扱いは {@link setPlayerRecord} と同じ。
 */
export function setPlayRecord(patch: ScoreRecordPatch): void {
    const reported = report(patch, "play");
    if (!reported) {
        return;
    }
    reported.external.setPlayRecord(reported.record);
    remember(reported.known, reported.record);
}

let _warnedAboutDetection = false;

/**
 * WHY: 本ライブラリはアクティブインスタンスか判定するAPIの存在を前提としている。
 * 動作しない致命的問題は警告で知らせる。
 */
function warnIfCannotDetect(): void {
    if (_warnedAboutDetection) {
        return;
    }
    _warnedAboutDetection = true;
    if (typeof console !== "undefined" && console && console.warn) {
        console.warn(
            "[akashic-scoreboard] この実行基盤では g.game.isActiveInstance() が" +
                "使えないため、記録を報告しません。" +
                "Akashic Engine の版を上げてください。",
        );
    }
}

function report(
    patch: ScoreRecordPatch,
    subject: string,
): {
    external: ScoreboardExternal;
    record: ScoreRecordPatch;
    known: { [key: string]: true };
} | null {
    const external = findExternal();
    if (!external) {
        return null;
    }
    // WHY: 判定できないときは報告しない。載らないほうが、アクティブでない
    // インスタンスから来た記録が載るよりよい
    if (!canDetectActiveInstance()) {
        warnIfCannotDetect();
        return null;
    }
    if (!isActiveInstance()) {
        return null;
    }
    const known = sentKeysOf(subject);
    const normalized = normalizeRecordPatch(patch, external.limits, known);
    warnDropped(normalized.dropped);
    // 捨てられて空になった差分は送らない。知らせるのは warnDropped が済ませている
    if (isEmpty(normalized.record)) {
        return null;
    }
    return { external: external, record: normalized.record, known: known };
}

function isEmpty(record: ScoreRecordPatch): boolean {
    for (const key in record) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            return false;
        }
    }
    return true;
}
