import path from "node:path";
import {
    tokenStore,
    uploadCacheStore,
    md5FromBuffer,
    md5FromFile,
    readBinaryFile,
    getNormalizeFilePath,
} from "@wenyan-md/core/wrapper";

const TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const DRAFT_GET_URL = "https://api.weixin.qq.com/cgi-bin/draft/get";
const DRAFT_UPDATE_URL = "https://api.weixin.qq.com/cgi-bin/draft/update";
const MATERIAL_ADD_URL = "https://api.weixin.qq.com/cgi-bin/material/add_material";

const MIME: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
};

export interface WechatArticle {
    title: string;
    author?: string;
    digest?: string;
    content: string;
    content_source_url?: string;
    thumb_media_id: string;
    need_open_comment?: number;
    only_fans_can_comment?: number;
}

export interface UploadedImage {
    media_id: string;
    url: string;
}

function assertWechatSuccess(data: any, ctx: string): void {
    if (data && typeof data === "object" && "errcode" in data && data.errcode !== 0) {
        throw new Error(`${ctx}失败 (${data.errcode}): ${data.errmsg}`);
    }
}

/**
 * Reuse core's tokenStore cache (~/.config/wenyan-md/token.json). Refresh via the
 * WeChat token endpoint using WECHAT_APP_ID / WECHAT_APP_SECRET when the cache is stale.
 */
export async function getAccessToken(): Promise<string> {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    if (!appId || !appSecret) {
        throw new Error("请通过环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET 提供公众号凭据");
    }
    const cached = tokenStore.getToken(appId);
    if (cached) {
        return cached;
    }
    const res = await fetch(
        `${TOKEN_URL}?grant_type=client_credential&appid=${appId}&secret=${appSecret}`,
    );
    if (!res.ok) {
        throw new Error(await res.text());
    }
    const data: any = await res.json();
    assertWechatSuccess(data, "获取 access_token");
    await tokenStore.setToken(appId, data.access_token, data.expires_in);
    return data.access_token as string;
}

/** Fetch a draft and return its news_item array (one entry per article in the draft). */
export async function getDraftNewsItems(mediaId: string): Promise<any[]> {
    const token = await getAccessToken();
    const res = await fetch(`${DRAFT_GET_URL}?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: mediaId }),
    });
    if (!res.ok) {
        throw new Error(await res.text());
    }
    const data: any = await res.json();
    assertWechatSuccess(data, "获取草稿");
    if (!Array.isArray(data.news_item)) {
        throw new Error(`草稿不存在或没有 news_item: ${JSON.stringify(data)}`);
    }
    return data.news_item;
}

/** Update one article (by index) inside an existing draft. */
export async function updateDraft(mediaId: string, index: number, article: WechatArticle): Promise<void> {
    const token = await getAccessToken();
    const res = await fetch(`${DRAFT_UPDATE_URL}?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: mediaId, index, articles: article }),
    });
    if (!res.ok) {
        throw new Error(await res.text());
    }
    const data: any = await res.json();
    assertWechatSuccess(data, "更新草稿");
}

async function uploadMaterialBuffer(
    buf: Buffer,
    filename: string,
    type: string,
    token: string,
): Promise<UploadedImage> {
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(buf)], { type }), filename);
    const res = await fetch(`${MATERIAL_ADD_URL}?access_token=${token}&type=image`, {
        method: "POST",
        body: form,
    });
    if (!res.ok) {
        throw new Error(await res.text());
    }
    const data: any = await res.json();
    assertWechatSuccess(data, "上传素材");
    let url = String(data.url || "");
    if (url.startsWith("http://")) {
        url = url.replace(/^http:\/\//i, "https://");
    }
    return { media_id: String(data.media_id || ""), url };
}

function resolveLocalPath(src: string, relativePath?: string): string {
    if (path.isAbsolute(src)) {
        return getNormalizeFilePath(src);
    }
    if (relativePath) {
        return getNormalizeFilePath(path.join(relativePath, src));
    }
    return getNormalizeFilePath(src);
}

/**
 * Upload an image (local path or remote URL) to WeChat as permanent material,
 * deduped through core's uploadCacheStore. Images already hosted on mmbiz.qpic.cn
 * are returned as-is (no media_id available without re-upload).
 */
export async function uploadImageFromSource(
    src: string,
    token: string,
    relativePath?: string,
): Promise<UploadedImage> {
    if (src.startsWith("https://mmbiz.qpic.cn")) {
        return { media_id: "", url: src };
    }

    if (/^https?:\/\//i.test(src)) {
        const resp = await fetch(src);
        if (!resp.ok) {
            throw new Error(`下载图片失败: ${src}`);
        }
        const ab = await resp.arrayBuffer();
        if (ab.byteLength === 0) {
            throw new Error(`远程图片大小为 0，无法上传: ${src}`);
        }
        const buf = Buffer.from(ab);
        const md5 = md5FromBuffer(buf);
        const cached = await uploadCacheStore.get(md5);
        if (cached) {
            return { media_id: cached.media_id, url: cached.url };
        }
        const base = path.basename(src.split("?")[0]);
        const ext = path.extname(base).toLowerCase();
        const filename = ext ? base : `${base}.jpg`;
        const type = MIME[ext] || resp.headers.get("content-type") || "image/jpeg";
        const uploaded = await uploadMaterialBuffer(buf, filename, type, token);
        await uploadCacheStore.set(md5, uploaded.media_id, uploaded.url);
        return uploaded;
    }

    const localPath = resolveLocalPath(src, relativePath);
    const buf = await readBinaryFile(localPath);
    if (buf.length === 0) {
        throw new Error(`本地图片大小为 0，无法上传: ${localPath}`);
    }
    const md5 = await md5FromFile(localPath);
    const cached = await uploadCacheStore.get(md5);
    if (cached) {
        return { media_id: cached.media_id, url: cached.url };
    }
    const base = path.basename(localPath);
    const ext = path.extname(base).toLowerCase();
    const filename = ext ? base : `${base}.jpg`;
    const type = MIME[ext] || "image/jpeg";
    const uploaded = await uploadMaterialBuffer(buf, filename, type, token);
    await uploadCacheStore.set(md5, uploaded.media_id, uploaded.url);
    return uploaded;
}
