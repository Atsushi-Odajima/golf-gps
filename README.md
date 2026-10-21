# Golf GPS — コースマップとGPS距離計測

ゴルフコースのホール画像にティー・グリーン等の位置を設定し、現在位置・距離・移動軌跡を確認する、スマートフォン向けWebアプリです。

## できること

- コース・ホールを作成し、ホール画像と位置を登録・編集する。
- GPSの現在位置と精度を表示し、登録した位置との距離を計算する。
- 対応端末でコンパスを利用し、ラウンド中の軌跡を記録する。
- コースマップURLからホール情報・画像の取込を試す。
- コース・画像データをブラウザへ保存し、JSONバックアップを出力・復元する。

## ローカルで試す

Next.js 16系・React 19・TypeScriptの構成です。対応するNode.js環境を用意します（依存バージョンは [package.json](package.json) とlockfileを参照）。

```sh
npm ci
npm run dev
```

http://localhost:3000 を開きます。新しいコースを作成 → ホール画像と地点を設定 → ラウンド画面を開く、の順で確認できます。

```sh
npm run build
npm start
```

スマートフォンで位置情報・コンパスを使う場合は、HTTPSで配信し、端末の権限を許可してください。PCのlocalhostはスマートフォンから直接開くURLではありません。

## データと外部通信

- コース・画像：IndexedDB。進行中ラウンド：localStorage。アカウント間のクラウド同期機能ではありません。
- URL取込：Next.jsのAPIが指定ページと画像を取得します。サイト構造に依存するため、任意のコースサイトへの対応を保証しません。
- ブラウザの保存領域を消去すると記録が失われます。重要な記録はJSONバックアップを取得してください。
- 取込には利用可能な画像・URLを使ってください。URL取得APIの接続先制限・認証等は、インターネット公開運用の前に別途確認が必要です。

## 実装の見どころ

- [src/lib/geo.ts](src/lib/geo.ts)：球面距離・方位・コース画像上への座標変換。
- [src/lib/storage.ts](src/lib/storage.ts)：IndexedDB、画像保存、JSONバックアップと移行。
- [src/lib/useGeolocation.ts](src/lib/useGeolocation.ts) / [src/lib/useCompass.ts](src/lib/useCompass.ts)：端末の位置・方位情報。
- [src/lib/importCourse.ts](src/lib/importCourse.ts) / [src/app/api](src/app/api)：コース情報と画像の取込。
- [src/app/course](src/app/course)：ホール編集・ラウンド画面。

## 現在の制限

GPSと画像への地点設定による概算です。測量機器の精度や、ラウンド規則への適合を保証するものではありません。
このリポジトリには専用の自動テストスクリプトは定義されていません。ビルド確認に加え、実機で位置精度・権限拒否・画像位置合わせ・バックアップ復元を確認してください。

制作・管理：**Atsushi Odajima**。実装にAI支援を利用しています。
