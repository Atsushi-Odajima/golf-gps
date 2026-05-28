import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new Response("url required", { status: 400 });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return new Response("invalid url", { status: 400 });
  }
  // Only allow http(s)
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new Response("invalid scheme", { status: 400 });
  }
  try {
    const res = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Referer: target.origin + "/",
        Accept: "image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return new Response(`fetch failed: ${res.status}`, { status: 502 });
    }
    const contentType = res.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return new Response("not an image", { status: 415 });
    }
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
