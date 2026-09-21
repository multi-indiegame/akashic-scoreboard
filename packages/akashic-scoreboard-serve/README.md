# @multi-indiegame/akashic-scoreboard-serve

[`@multi-indiegame/akashic-scoreboard`](../akashic-scoreboard) を `akashic serve` の上で動作確認するためのバックエンド。

**Akashic Engine のマルチモード**で動くコンテンツを作っている方向けです。実行基盤に組み込むものではありません（それは [`@multi-indiegame/akashic-scoreboard-plugin`](../akashic-scoreboard-plugin) です）。

> **[`@akashic-extension/coe`](https://github.com/akashic-games/coe) を使ったコンテンツでは、このパッケージは使えません。** 記録は受け取られますが、「スコアボード」タブに出てきません（`akashic serve` を起動した端末には出ます）。coe を使っているなら [`@multi-indiegame/akashic-scoreboard-serve-coe`](../akashic-scoreboard-serve-coe) を使ってください。できることは同じです。

## これは何をするか

素の `akashic serve` は scoreboard に対応していないので、そのままでは `isSupported()` が `false` になり、`setPlayerRecord()` を呼んでも何も起きません。このパッケージを `sandbox.config.js` から読ませると、`akashic serve` の中で実行基盤の代役を務めます。

- アクティブインスタンスに `g.game.external.scoreboard` を生やします
- 登録された記録を **akashic serve の画面内**に出します（ドックの「スコアボード」タブ → 全画面表示）
- 記録を **`akashic serve` を起動した端末**にも出します
- 形が合わずに破棄された値も警告として出します
- 記録は実行基盤と同じようにマージ（後勝ち・`null` で削除）して保持します
- 指定すれば、その結果を JSON ファイルにも書き出します（既定では書き出しません）

**集計も公開もしません。** 見られるのは「いま何が記録されているか」までです。

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
npm install --save-dev @multi-indiegame/akashic-scoreboard-serve
```

### 3. sandbox.config.js に書く

**`server.external` と `client.external` の両方**に書きます。

```js
module.exports = {
  // ... 既存の設定
  server: {
    external: {
      scoreboard:
        require.resolve("@multi-indiegame/akashic-scoreboard-serve/server.js"),
    },
  },
  client: {
    external: {
      scoreboard: require.resolve("@multi-indiegame/akashic-scoreboard-serve"),
    },
  },
};
```

`require()` ではなく `require.resolve()` です。`akashic serve` に渡すのはパスであって値ではありません。

`client.external` を省くと画面には出ませんが、端末への出力は動きます。

### 4. 起動する

```sh
akashic serve
```

ブラウザでゲームを開くと（= プレイが作られると）次の行が出ます。`akashic serve` を起動しただけでは出ません。

```
[akashic-scoreboard-serve] 記録を受け取ります。akashic serve の画面の「スコアボード」タブで確認できます。
[akashic-scoreboard-serve] 記録の送信先: http://localhost:3300
```

**送信先は必ず確かめてください。** サーバ側は akashic serve 自身の待ち受け先を推定しており、外れているとその宛先へ記録を送ってしまいます。違っていれば[指定してください](#akashic-serve-の待ち受け先を教える)。

## 画面で見る

akashic serve の画面右端に出る**「スコアボード」タブ**を押すと、いま記録されている内容が全画面で出ます。記録が入るたびに更新されます。閉じるときは「閉じる」か、背景を押してください。

画面の先頭には**最終更新の時刻と、どのプレイの記録か**が出ます。送信に失敗したときや、次の注意書きのとおり一部を破棄して送ったときに、古い値を現在の値として読まないためのものです。

### 記録が大きいときの注意

akashic serve は 100KB を超える送信を受け付けません。記録の全体がそれに近づくと、**入るところまでを送ります。** 破棄されるのはプレイヤーの記録だけとは限らず、[上限を大きくした](#上限を本番に合わせる)構成ではプレイ自体の記録も破棄されます。そのときは画面に「記録が大きいため、一部の記録を表示していません（プレイ自体の記録を含みます）」と出て、`akashic serve` を起動した端末には何を何件送ったか（プレイヤー N / M 人、プレイ自体の記録 N / M 件）が出ます。破棄されるのは画面に送る分だけで、ファイルへの書き出しと端末への出力は全件のままです。

### 複数のプレイを開いたとき

記録はプレイごとに分かれていて、それぞれ自分のプレイの playlog へ送ります。画面には、いま開いているプレイの記録が出ます。

## 書き出されるファイルの内容

[書き出しを有効にした](#記録をファイルに書き出す)ときの中身です。

```jsonc
{
  "play": {
    "difficulty": "hard",
  },
  "players": {
    "player-1": {
      "score": 3000,
      "cleared": true,
    },
  },
}
```

## 設定

環境変数でも `sandbox.config.js` の `configure()` でも指定できます。両方に書いたときは `configure()` の指定を使います。

### 記録をファイルに書き出す

**既定ではファイルを作りません。** 記録はメモリ上にだけ持ちます。diff を取りたいときなど、ファイルが必要なときだけ書き出し先を指定してください。

```sh
AKASHIC_SCOREBOARD_SERVE_OUTPUT=./tmp/records.json akashic serve
```

相対パスは `akashic serve` を起動したディレクトリから解決します。親ディレクトリが無ければ作ります。書き出したファイルは自動では消えません。

プレイごとに記録は分かれますが、**書き出し先は 1 つ**です。複数のプレイを同時に開くと、最後に記録が入ったプレイの内容で上書きされます。

### akashic serve の待ち受け先を教える

記録を playlog へ流すために、サーバ側は akashic serve 自身の待ち受け先を知る必要があります。通常は起動時の引数と cli-serve の設定から自動で拾うので指定は要りません。起動時に出る「記録の送信先」が実際と違うときだけ指定してください。

指定は `http://ホスト名:ポート` の形です。スキームを書き忘れた指定は読めないので、警告を出して自動の推定に戻ります。

```sh
AKASHIC_SCOREBOARD_SERVE_ORIGIN=http://localhost:3400 akashic serve --port 3400
```

### 上限を本番に合わせる

`sandbox.config.js` の中で `configure()` を呼び出し、設定をカスタマイズしてください。

```javascript
// sandbox.config.js
const scoreboardServe = require("@multi-indiegame/akashic-scoreboard-serve/server.js");

scoreboardServe.configure({
  outputPath: "./tmp/records.json",
  serveOrigin: "http://localhost:3400",
  limits: { keysPerPlayer: 16, stringLength: 64 },
});

module.exports = {
  server: {
    external: {
      scoreboard:
        require.resolve("@multi-indiegame/akashic-scoreboard-serve/server.js"),
    },
  },
  client: {
    external: {
      scoreboard: require.resolve("@multi-indiegame/akashic-scoreboard-serve"),
    },
  },
};
```

指定したキーだけが変わります。`akashic serve` を起動したまま `sandbox.config.js` を書き換えた場合は、プレイを作り直せば新しい設定になります。

## 注意点: MessageEvent が全インスタンスに配信されます

記録が更新されるたびに、次の MessageEvent が playlog に載り、**全インスタンスへ配信されます**。画面に出すために、サーバ側で受け取った記録をブラウザ側へ運ぶ必要があるためです。

| 項目     | 値                                          |
| -------- | ------------------------------------------- |
| playerId | `:multi-indiegame`                          |
| type     | `@multi-indiegame/akashic-scoreboard-serve` |

コンテンツ側で `g.MessageEvent` を扱っている場合は、**自分宛でない `type` を無視してください**。このイベントは playlog のダウンロードにも含まれ、リプレイ時にも再生されます。

配信されるのは `akashic serve` で動作確認しているときだけです。**本番の実行基盤でこのイベントが配信されることはありません。**

[`@multi-indiegame/akashic-scoreboard-serve-coe`](../akashic-scoreboard-serve-coe) では、これが MessageEvent ではなく OperationEvent で流れます（`playerId` と `type` は同じです）。

## 代行していないこと

- **集計・ランキング・公開。** 本番の実行基盤の仕事です
- **誰の記録かの解決。** `playerId` をそのまま鍵として書き出します。本番では実行基盤がアカウントと突き合わせます
- **掲載の同意。** 本番では名前の掲載に同意した人だけが統計に載ります

## ライセンス

MIT
