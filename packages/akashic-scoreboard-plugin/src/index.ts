import {
    EXTERNAL_KEY,
    ObjectSignature,
    ScoreRecordPatch,
    ScoreboardExternal,
    ScoreboardLimits,
    UNTRUSTED_SIGNATURE,
    normalizeRecordPatch,
} from "@multi-indiegame/akashic-scoreboard/protocol";

export {
    DEFAULT_LIMITS,
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

    constructor(param: ScoreboardPluginParameterObject) {
        this._backend = param.backend;
        this._limits = param.limits;
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
                this._record({ kind: "player", playerId: playerId }, patch);
            },
            setPlayRecord: (patch) => {
                this._record({ kind: "play" }, patch);
            },
        };
        if (this._limits) {
            external.limits = this._limits;
        }
        return external;
    }

    _record(subject: ScoreRecordSubject, patch: ScoreRecordPatch): void {
        // WHY: コンテンツから来た値はライブラリを経由したとは限らない（同一
        // オリジンなら external を直接叩ける）。受け取る側でもう一度検証する
        const normalized = normalizeRecordPatch(patch, this._limits);
        const rejected: RejectedRecordEntry[] = normalized.dropped.map(
            (entry) => ({ key: entry.key, reason: entry.reason }),
        );
        try {
            this._backend.record(subject, normalized.record, rejected);
        } catch (_err) {
            // WHY: 実行基盤の都合でコンテンツの進行を止めない。記録が残らない
            // ことの影響は、そのプレイに閉じる
        }
    }
}
