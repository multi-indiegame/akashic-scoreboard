import {
    DroppedEntry,
    EXTERNAL_KEY,
    ObjectSignature,
    ScoreRecordPatch,
    ScoreboardExternal,
    ScoreboardLimits,
    UNTRUSTED_SIGNATURE,
    normalizeRecordPatch,
    readLimit,
} from "@multi-indiegame/akashic-scoreboard/protocol";

export {
    DEFAULT_LIMITS,
    readLimit,
    DropReason,
    DroppedEntry,
    EXTERNAL_KEY,
    RECORD_KEY_PATTERN,
    ScoreValue,
    ScoreRecordPatch,
    ScoreboardLimits,
    isValidRecordKey,
    normalizeRecordPatch,
} from "@multi-indiegame/akashic-scoreboard/protocol";

/** 記録の宛先。プレイヤーごとの記録か、部屋そのものの記録か */
export type ScoreRecordSubject =
    { kind: "player"; playerId: string } | { kind: "play" };

/** 検証を通らずに廃棄された値。実行基盤が調査用にログへ残すためのもの */
export interface RejectedRecordEntry {
    key: string;
    reason: string;
}

/**
 * 実行基盤が実装する側。
 *
 * 記録の保存先・保持期間・誰の記録として扱うか・集計と公開の方法は、すべて
 * 実装側の責務。このプラグインは呼び出しを橋渡しするだけで、セキュリティ境界では
 * ない（PROTOCOL.md 8 章）。
 *
 * **実行基盤が知らない playerId の扱いを決めるのもこの実装。** プラグインは
 * コンテンツが渡した文字列をそのまま運ぶ。
 */
export interface ScoreboardBackend {
    /**
     * 記録の差分を受け取る。
     *
     * 同じキーを後から受け取ったら上書きし、値が `null` ならそのキーを消すこと。
     *
     * `rejected` は形が合わずに破棄された値。**黙って消さずログに残すこと。**
     * 投稿者から「値は送っているのに記録されない」と問われたときに、ここが
     * 唯一の手がかりになる。
     */
    record(
        subject: ScoreRecordSubject,
        patch: ScoreRecordPatch,
        rejected: RejectedRecordEntry[],
    ): void;
}

export interface ScoreboardPluginParameterObject {
    backend: ScoreboardBackend;
    /**
     * この実行基盤が課す上限。省略すると拡張ライブラリの既定値が使われる。
     *
     * ここで指定した値はコンテンツ側からも読めるので、ライブラリが送る前の
     * 段階でも同じ上限で揃う。ただし**最終的な判定はこのプラグインが行う**ので、
     * 上限が渡らない実行基盤でも守られる。
     */
    limits?: ScoreboardLimits;
}

/**
 * アクティブインスタンスの `g.game.external.scoreboard` を組み立てる。
 *
 * WHY: 生える場所は実行基盤が決める。この拡張は**アクティブインスタンスの報告
 * だけを記録する**という指針で、拡張ライブラリ自身が
 * `g.game.isActiveInstance()` で守っているため、生やす場所の取り決めに依存しない。
 * それでもアクティブ側にだけ生やすのを勧める。生やさなければ、パッシブ側で
 * 余計な処理も通信も起きない。
 */
export class ScoreboardPlugin {
    name: string = EXTERNAL_KEY;
    untrustedSignature: ObjectSignature = UNTRUSTED_SIGNATURE;
    _backend: ScoreboardBackend;
    _limits?: ScoreboardLimits;
    /**
     * 相手ごとに、これまで報告を受けたキー。
     *
     * WHY: キー数の上限は積み上がった記録全体に掛かる。1 回の報告ごとに数え
     * 直すと、別々の名前で送り続けるだけで上限を越えられてしまう。まとめた
     * 記録を持つのはバックエンドだが、上限の判定はここで完結させたいので、
     * 判定に要るキー名だけを控える。
     *
     * WHY: 数えるのは**報告したキー**で、バックエンドが実際に保存できたか
     * では数えない。保存の成否を返す口が無い以上、それを待つとコンテンツ側の
     * 控えとずれる。
     *
     * WHY: このプラグインは 1 プレイにつき 1 つ作られるので、控えた内容は
     * そのプレイが終われば捨てられる。
     */
    _knownKeys: { [subject: string]: { [key: string]: true } };

    constructor(param: ScoreboardPluginParameterObject) {
        this._backend = param.backend;
        // WHY: 渡された実体をそのまま持つと、createExternal() で露出した先から
        // 書き換えられて上限が効かなくなる。複製して手元に閉じる
        this._limits = param.limits ? copyLimits(param.limits) : undefined;
        this._knownKeys = Object.create(null) as {
            [subject: string]: { [key: string]: true };
        };
    }

    /**
     * `externalValue` に載せるオブジェクトを返す。
     *
     * headless-driver の `RunnerV3` では、ここで返した値がアクティブ
     * インスタンスの `g.game.external.scoreboard` になる。
     */
    createExternal(): ScoreboardExternal {
        const external: ScoreboardExternal = {
            setPlayerRecord: (playerId, patch) => {
                if (typeof playerId !== "string" || playerId === "") {
                    return;
                }
                // WHY: 長すぎる playerId は相手として扱わない。控えにも記録にも
                // 載せないので、ここで打ち切る。コンテンツ側のライブラリが
                // 警告を出す
                if (
                    playerId.length > readLimit(this._limits, "playerIdLength")
                ) {
                    return;
                }
                this._record({ kind: "player", playerId: playerId }, patch);
            },
            setPlayRecord: (patch) => {
                this._record({ kind: "play" }, patch);
            },
        };
        if (this._limits) {
            // WHY: コンテンツから見えるのは判定に使う実体とは別の複製。
            // 書き換えられても判定は変わらない
            external.limits = copyLimits(this._limits);
        }
        return external;
    }

    _record(subject: ScoreRecordSubject, patch: ScoreRecordPatch): void {
        const id = subjectId(subject);
        const existing = this._knownKeys[id];
        const known =
            existing ?? (Object.create(null) as { [key: string]: true });
        // WHY: コンテンツから来た値はライブラリを経由したとは限らない（同一
        // オリジンなら external を直接叩ける）。受け取る側でもう一度検証する
        const normalized = normalizeRecordPatch(patch, this._limits, known);
        const rejected: RejectedRecordEntry[] = normalized.dropped.map(
            (entry) => ({ key: entry.key, reason: entry.reason }),
        );
        const added: string[] = [];
        for (const key of Object.keys(normalized.record)) {
            if (normalized.record[key] === null) {
                delete known[key];
            } else if (known[key] !== true) {
                added.push(key);
            }
        }
        // WHY: まだ記録を持たない相手が新しく記録を持つときだけ、相手の数を
        // 数える。キーを消すだけの報告や、何も通らなかった報告では数えない
        if (!existing && added.length > 0 && this._isFull()) {
            for (const key of added) {
                rejected.push({ key: key, reason: "TooManySubjects" });
            }
            this._report(subject, {}, rejected);
            return;
        }
        for (const key of added) {
            known[key] = true;
        }
        // WHY: 控えるのは報告する前。バックエンドが例外を出した分を控えないと、
        // コンテンツ側の控えとずれて、正当な記録が捨てられる
        //
        // WHY: 記録が 1 つも残らない相手の枠は手放す。持ち続けると、キーを
        // 消すだけの報告を繰り返して相手の数の上限を埋められる
        if (Object.keys(known).length > 0) {
            this._knownKeys[id] = known;
        } else if (existing) {
            delete this._knownKeys[id];
        }
        this._report(subject, normalized.record, rejected);
    }

    _isFull(): boolean {
        return (
            Object.keys(this._knownKeys).length >=
            readLimit(this._limits, "subjectsPerPlay")
        );
    }

    _report(
        subject: ScoreRecordSubject,
        record: ScoreRecordPatch,
        rejected: RejectedRecordEntry[],
    ): void {
        try {
            this._backend.record(subject, record, rejected);
        } catch (_err) {
            // WHY: 実行基盤の都合でコンテンツの進行を止めない。記録が残らない
            // ことの影響は、そのプレイに閉じる
        }
    }
}

function subjectId(subject: ScoreRecordSubject): string {
    return subject.kind === "play" ? "play" : `player:${subject.playerId}`;
}

/**
 * WHY: フィールドを並べずに写すのは、新しい版の拡張ライブラリが増やした上限を
 * 落とさないため。このプラグインが知らない項目もコンテンツ側へ渡す。
 */
function copyLimits(limits: ScoreboardLimits): ScoreboardLimits {
    const source = limits as { [key: string]: unknown };
    const copy: { [key: string]: unknown } = {};
    for (const key of Object.keys(source)) {
        copy[key] = source[key];
    }
    return copy as ScoreboardLimits;
}
