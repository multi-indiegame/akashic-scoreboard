# @multi-indiegame/akashic-scoreboard

プレイ記録を実行基盤へ報告するための Akashic Engine 拡張ライブラリ（コンテンツ側）。

ゲームが「このプレイヤーのスコアは 1200 だった」と報告すると、対応している実行基盤がそれを集計して統計として見せます。集計も表示も実行基盤の仕事で、このライブラリは報告するところまでを受け持ちます。

## インストール

```sh
akashic install @multi-indiegame/akashic-scoreboard
```

`game.json` に次が入っていれば成功です。

```jsonc
"environment": {
  "external": {
    "scoreboard": "0"
  }
}
```

## 使い方

```javascript
const scoreboard = require("@multi-indiegame/akashic-scoreboard");

// プレイヤーごとの記録
scoreboard.setPlayerRecord(playerId, {
  score: 1200,
  stage: "3-2",
  cleared: true,
});

// プレイヤーに紐づかないプレイ自体の記録
scoreboard.setPlayRecord({ difficulty: "hard" });
```

同じキーを後から書くと上書きされ、`null` を渡すとそのキーを消します。

```javascript
scoreboard.setPlayerRecord(playerId, { score: 3000 }); // 上書き
scoreboard.setPlayerRecord(playerId, { stage: null }); // 削除
```

`playerId` は、そのプレイヤーについてコンテンツが観測している in-game playerId（`ev.player.id` の値）を渡してください。

## いちばん起きやすい誤り

**アクティブインスタンスに通らない分岐の中で呼ぶと、記録は登録されません。**

```javascript
// 登録されない。この分岐はプレイヤーの画面でしか通らない
if (player.id === g.game.selfId) {
  scoreboard.setPlayerRecord(player.id, { score: score });
}
```

```javascript
// 登録される。このコードは全インスタンスで実行されるため、アクティブインスタンスでの実行で登録される。
scene.onMessage.add((ev) => {
  scoreboard.setPlayerRecord(ev.player.id, { score: ev.data.score });
});
```

全インスタンスで実行する必要はありません。登録される条件は「アクティブインスタンスで実行されること」だけです。次のように明示的に囲んでも構いません（動作は変わりませんが、意図がコードに残ります）。

```javascript
if (g.game.isActiveInstance()) {
  scoreboard.setPlayerRecord(playerId, { score: score });
}
```

## なぜアクティブインスタンスだけなのか

このライブラリは、**アクティブインスタンスの報告だけを記録します**。理由は2つあります。

- パッシブインスタンスの報告は、手元で書き換えられる恐れがある
- アクティブインスタンスはゲーム情報を集約して持っていると期待できる

## API

### `setPlayerRecord(playerId, patch)`

プレイヤーごとの記録を登録します。

### `setPlayRecord(patch)`

プレイヤーに関係しない、プレイ自体に関する記録を登録します。扱いは `setPlayerRecord` と同じです。

### `isSupported()`

このインスタンスから記録が登録できるかを返します。

**結果はローカルです。** 同じ実行基盤の上でも、アクティブインスタンスでは `true`、プレイヤーの画面では `false` になります。記録に関する表示を出すかどうかのようなローカルな判断にだけ使い、**ゲーム状態をこれで分岐させないでください**。

対応していない実行基盤（素の `akashic serve` や Akashic の headless runner）では `false` になり、`setPlayerRecord()` は何もしません。例外は出ないので、対応・非対応のどちらにも同じコンテンツを投稿できます。

## 記録できる値

| 種類          | 制限                                                               |
| ------------- | ------------------------------------------------------------------ |
| キー名        | 半角英数字と `_` `-` `:` を 1〜32 文字（`^[a-zA-Z0-9_:-]{1,32}$`） |
| 値            | 有限の number / string / boolean（`NaN` と `Infinity` は不可）     |
| キー数        | 既定 100（実行基盤が変えられる）                                   |
| string の長さ | 既定 140 文字（実行基盤が変えられる）                              |

**上限を決めるのは実行基盤**で、上の既定値は何も指定されなかったときのものです。実行基盤は緩める方向にも厳しくする方向にも指定できます。

形に合わない値は**そのキーだけが廃棄され**、コンソールに警告が出ます。長すぎる string は切り詰めずに廃棄されます（切り詰めると別の値として集計されてしまうため）。

## 動作確認

`akashic serve` で確かめるには [@multi-indiegame/akashic-scoreboard-serve](../akashic-scoreboard-serve) を使ってください。

## 実行基盤を作る方は

[@multi-indiegame/akashic-scoreboard-plugin](../akashic-scoreboard-plugin) を参照してください。

## 仕様

[akashic-external-protocol](https://github.com/multi-indiegame/akashic-external-protocol) に従います。

## ライセンス

MIT
