# @multi-indiegame/akashic-scoreboard-serve-coe

[`@akashic-extension/coe`](https://github.com/akashic-games/coe) を使ったコンテンツで、プレイ記録を `akashic serve` の画面で確認するための実行基盤の代役。

> **experimental（0.1.0）**
> サーバ側で受け取った記録をブラウザ側へ渡すのに **OperationEvent** を使っています。これは本来、コンテンツが `game.json` で宣言した操作プラグインのための種別で、このパッケージは番号を宣言せずに使います。[コンテンツ側の操作プラグインと衝突しえます](#使う操作プラグインコード)。

**coe を使ったコンテンツでは [`@multi-indiegame/akashic-scoreboard-serve`](../akashic-scoreboard-serve) は使えません。** 記録は受け取られますが、画面には出てきません（`akashic serve` を起動した端末には出ます）。coe を使っているならこちらを使ってください。

できることは `@multi-indiegame/akashic-scoreboard-serve` と同じです。

- 登録された記録を **akashic serve の画面内**に出します（ドックの「スコアボード」タブ → 全画面表示）
- 記録を **`akashic serve` を起動した端末**にも出します
- 形が合わずに破棄された値も警告として出します
- 記録は実行基盤と同じようにマージ（後勝ち・`null` で削除）して保持します
- 指定すれば、その結果を JSON ファイルにも書き出します（既定では書き出しません）

## セットアップ

### 1. 拡張ライブラリ本体が入っているか確認する

`game.json` に次の記述があれば入っています。

```jsonc
"environment": {
  "external": {
    "scoreboard": "0"
  }
}
```

無ければ、先に本体をインストールしてください。

```sh
akashic install @multi-indiegame/akashic-scoreboard
```

### 2. このパッケージをインストールする

```sh
npm install --save-dev @multi-indiegame/akashic-scoreboard-serve-coe
```

### 3. sandbox.config.js に書く

**`server.external` と `client.external` の両方**に書きます。

```js
module.exports = {
  // ... 既存の設定
  server: {
    external: {
      scoreboard:
        require.resolve("@multi-indiegame/akashic-scoreboard-serve-coe/server.js"),
    },
  },
  client: {
    external: {
      scoreboard:
        require.resolve("@multi-indiegame/akashic-scoreboard-serve-coe"),
    },
  },
};
```

`require()` ではなく `require.resolve()` です。`akashic serve` に渡すのはパスであって値ではありません。

### 4. 起動する

```sh
akashic serve
```

ブラウザでゲームを開くと（= プレイが作られると）次の行が出ます。`akashic serve` を起動しただけでは出ません。

```
[akashic-scoreboard-serve] 記録を受け取ります。akashic serve の画面の「スコアボード」タブで確認できます。
[akashic-scoreboard-serve] 記録の送信先: http://localhost:3300
[akashic-scoreboard-serve] 記録を載せる playlog イベント: OperationEvent（操作プラグインコード 0x6d69）
```

**送信先は必ず確かめてください。** サーバ側は akashic serve 自身の待ち受け先を推定しており、外れているとその宛先へ記録を送ってしまいます。違っていれば[指定してください](../akashic-scoreboard-serve#akashic-serve-の待ち受け先を教える)。

## 画面の見方と設定

`@multi-indiegame/akashic-scoreboard-serve` と同じです。[そちらの README](../akashic-scoreboard-serve) を見てください。

- [画面で見る](../akashic-scoreboard-serve#画面で見る)
- [記録をファイルに書き出す](../akashic-scoreboard-serve#記録をファイルに書き出す)
- [akashic serve の待ち受け先を教える](../akashic-scoreboard-serve#akashic-serve-の待ち受け先を教える)

設定を変えるときは、`sandbox.config.js` の中で `configure()` を呼び出し、設定をカスタマイズしてください。本番に合わせた上限（`limits`）もここで渡します。

```javascript
// sandbox.config.js
const scoreboardServe = require("@multi-indiegame/akashic-scoreboard-serve-coe/server.js");

scoreboardServe.configure({
  outputPath: "./tmp/records.json",
  limits: { keysPerPlayer: 16, stringLength: 64 },
});

module.exports = {
  // ... セットアップに書いたものと同じ
};
```

指定したキーだけが変わります。`akashic serve` を起動したまま書き換えた場合は、プレイを作り直せば新しい設定になります。

## 使う操作プラグインコード

記録が更新されるたびに、**操作プラグインコード `0x6d69`（28009）の OperationEvent** が playlog に載り、全インスタンスへ配信されます。既定の番号で、[変えられます](#番号を変える)。配信されるのは `akashic serve` で動作確認しているときだけで、本番の実行基盤でこのイベントが流れることはありません。

コンテンツ側には次の影響があります。

- **同じ番号の操作プラグインを登録していると衝突します。** そのプラグインの `decode` にこの記録が渡ります。[番号を変えてください](#番号を変える)。
- **`scene.onOperation` を見ているなら、この番号の操作もコンテンツに渡ります。** 自分のコードでない操作は無視してください。
- このイベントは playlog のダウンロードにも含まれ、リプレイ時にも再生されます。

### 番号を変える

`sandbox.config.js` の中で `operationCode` を渡してください。`client.external` はそのままで構いません（画面側は番号を見ていません）。

```javascript
// sandbox.config.js
const scoreboardServe = require("@multi-indiegame/akashic-scoreboard-serve-coe/server.js");

scoreboardServe.configure({ operationCode: 30000 });

module.exports = {
  // ... セットアップに書いたものと同じ
};
```

実際に使っている番号は、起動時のログに出ます。

```
[akashic-scoreboard-serve] 記録を載せる playlog イベント: OperationEvent（操作プラグインコード 0x7530）
```

## ライセンス

MIT
