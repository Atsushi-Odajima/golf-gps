import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "./sw-register";

export const metadata: Metadata = {
  title: "壁ゴルフ距離計",
  description: "ゴルフ用GPS距離計＆スコアトラッカー",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "壁ゴルフ距離計",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a3d28",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="app-brand" aria-label="壁ゴルフ距離計">壁ゴルフ距離計</div>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
