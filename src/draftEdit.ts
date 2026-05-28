import { JSDOM } from "jsdom";
import { prepareRenderContext } from "@wenyan-md/core/wrapper";
import { buildMcpResponse, getInputContent } from "./utils.js";
import {
    getAccessToken,
    getDraftNewsItems,
    updateDraft,
    uploadImageFromSource,
    type WechatArticle,
} from "./wechatApi.js";

function toIndex(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Build the article payload for draft/update, preserving fields not being changed. */
function mergeArticle(existing: any, overrides: Partial<WechatArticle>): WechatArticle {
    return {
        title: overrides.title ?? existing.title ?? "",
        author: overrides.author ?? existing.author ?? "",
        digest: overrides.digest ?? existing.digest ?? "",
        content: overrides.content ?? existing.content ?? "",
        content_source_url: overrides.content_source_url ?? existing.content_source_url ?? "",
        thumb_media_id: overrides.thumb_media_id ?? existing.thumb_media_id ?? "",
        need_open_comment: overrides.need_open_comment ?? existing.need_open_comment ?? 0,
        only_fans_can_comment: overrides.only_fans_can_comment ?? existing.only_fans_can_comment ?? 0,
    };
}

/** Upload every local/remote <img> in the rendered HTML, rewriting src to the mmbiz URL. */
async function uploadBodyImages(
    html: string,
    token: string,
    relativePath?: string,
): Promise<{ html: string; firstImageMediaId: string }> {
    if (!html.includes("<img")) {
        return { html, firstImageMediaId: "" };
    }
    const dom = new JSDOM(html);
    const images = Array.from(dom.window.document.querySelectorAll("img")) as Element[];
    let firstImageMediaId = "";
    for (const element of images) {
        const src = element.getAttribute("src");
        if (!src) {
            continue;
        }
        const uploaded = await uploadImageFromSource(src, token, relativePath);
        element.setAttribute("src", uploaded.url);
        if (!firstImageMediaId && uploaded.media_id) {
            firstImageMediaId = uploaded.media_id;
        }
    }
    return { html: dom.serialize(), firstImageMediaId };
}

export const UPDATE_ARTICLE_SCHEMA = {
    name: "update_article",
    description:
        "Update an existing article in a '微信公众号' draft (草稿箱) instead of creating a new one. Re-renders the provided Markdown with the chosen theme, uploads body images, and overwrites the draft identified by media_id. Fields not provided are preserved from the existing draft.",
    inputSchema: {
        type: "object",
        properties: {
            media_id: {
                type: "string",
                description: "The media_id of the draft to update (returned by publish_article).",
            },
            index: {
                type: "number",
                description: "Article index within the draft (0-based). Defaults to 0.",
            },
            content: {
                type: "string",
                description: "New Markdown content. Provide this, 'file', or 'content_url'. Include frontmatter if present.",
            },
            content_url: {
                type: "string",
                description: "URL to a Markdown file with the new content.",
            },
            file: {
                type: "string",
                description: "Local path to a Markdown file with the new content.",
            },
            theme_id: {
                type: "string",
                description: "Theme id to apply (e.g., default, orangeheart, lapis, pie, maize, purple, phycat).",
            },
            title: {
                type: "string",
                description: "Optional title override (otherwise taken from frontmatter / existing draft).",
            },
            author: {
                type: "string",
                description: "Optional author override.",
            },
            thumb_media_id: {
                type: "string",
                description: "Optional cover thumbnail media_id override.",
            },
        },
        required: ["media_id"],
    },
} as const;

export async function updateArticle(args: Record<string, any>) {
    const mediaId = String(args.media_id || "");
    if (!mediaId) {
        throw new Error("media_id 是必填项");
    }
    const index = toIndex(args.index);
    const newsItems = await getDraftNewsItems(mediaId);
    const existing = newsItems[index];
    if (!existing) {
        throw new Error(`草稿 index=${index} 不存在（该草稿共有 ${newsItems.length} 篇文章）`);
    }

    const content = String(args.content || "");
    const contentUrl = String(args.content_url || "");
    const file = String(args.file || "");
    const themeId = String(args.theme_id || "");
    const hasNewContent = !!(content || contentUrl || file);

    const token = await getAccessToken();
    const overrides: Partial<WechatArticle> = {};

    if (hasNewContent) {
        if (!themeId) {
            throw new Error("提供新内容时必须指定 theme_id");
        }
        const renderOptions = {
            file: file ? file : contentUrl,
            theme: themeId,
            highlight: "solarized-light",
            macStyle: true,
            footnote: true,
        };
        const { gzhContent, absoluteDirPath } = await prepareRenderContext(content, renderOptions, getInputContent);
        if (!gzhContent.title) {
            throw new Error("未能找到文章标题");
        }
        const { html, firstImageMediaId } = await uploadBodyImages(gzhContent.content, token, absoluteDirPath);
        overrides.content = html;
        overrides.title = gzhContent.title;
        if (gzhContent.author) {
            overrides.author = gzhContent.author;
        }
        if (gzhContent.source_url) {
            overrides.content_source_url = gzhContent.source_url;
        }
        if (gzhContent.cover) {
            const cover = await uploadImageFromSource(gzhContent.cover, token, absoluteDirPath);
            if (cover.media_id) {
                overrides.thumb_media_id = cover.media_id;
            }
        } else if (firstImageMediaId) {
            overrides.thumb_media_id = firstImageMediaId;
        }
    }

    if (args.title) {
        overrides.title = String(args.title);
    }
    if (args.author !== undefined) {
        overrides.author = String(args.author);
    }
    if (args.thumb_media_id) {
        overrides.thumb_media_id = String(args.thumb_media_id);
    }

    await updateDraft(mediaId, index, mergeArticle(existing, overrides));
    return buildMcpResponse(`草稿已更新（media_id=${mediaId}, index=${index}）。`);
}

export const REPLACE_ARTICLE_IMAGE_SCHEMA = {
    name: "replace_article_image",
    description:
        "Replace one or more body images inside an existing '微信公众号' draft without re-rendering the article. Uploads the new image, then swaps the matching <img> src in the draft content.",
    inputSchema: {
        type: "object",
        properties: {
            media_id: {
                type: "string",
                description: "The media_id of the draft to edit.",
            },
            index: {
                type: "number",
                description: "Article index within the draft (0-based). Defaults to 0.",
            },
            new_image: {
                type: "string",
                description: "Local path or URL of the replacement image.",
            },
            target: {
                type: "string",
                description:
                    "Which image(s) to replace: 'first' (default), 'all', or a substring of the old image URL to match.",
            },
        },
        required: ["media_id", "new_image"],
    },
} as const;

export async function replaceArticleImage(args: Record<string, any>) {
    const mediaId = String(args.media_id || "");
    if (!mediaId) {
        throw new Error("media_id 是必填项");
    }
    const newImage = String(args.new_image || "");
    if (!newImage) {
        throw new Error("new_image 是必填项（本地路径或 URL）");
    }
    const index = toIndex(args.index);
    const target = String(args.target || "first");

    const newsItems = await getDraftNewsItems(mediaId);
    const existing = newsItems[index];
    if (!existing) {
        throw new Error(`草稿 index=${index} 不存在（该草稿共有 ${newsItems.length} 篇文章）`);
    }

    const token = await getAccessToken();
    const uploaded = await uploadImageFromSource(newImage, token);

    const dom = new JSDOM(existing.content);
    const images = Array.from(dom.window.document.querySelectorAll("img")) as Element[];
    if (images.length === 0) {
        throw new Error("正文中没有找到图片");
    }
    let replaced = 0;
    images.forEach((element, i) => {
        const src = element.getAttribute("src") || "";
        let hit: boolean;
        if (target === "all") {
            hit = true;
        } else if (target === "first") {
            hit = i === 0;
        } else {
            hit = src.includes(target);
        }
        if (hit) {
            element.setAttribute("src", uploaded.url);
            replaced++;
        }
    });
    if (replaced === 0) {
        throw new Error(`没有匹配到要替换的图片（target=${target}）`);
    }

    await updateDraft(mediaId, index, mergeArticle(existing, { content: dom.serialize() }));
    return buildMcpResponse(`已替换 ${replaced} 张正文图片（media_id=${mediaId}, index=${index}）。`);
}

export const REPLACE_ARTICLE_COVER_SCHEMA = {
    name: "replace_article_cover",
    description:
        "Replace the list thumbnail (封面图 / thumb_media_id) of an existing '微信公众号' draft — the cover shown before the article is opened. Uploads the image as permanent material and updates the draft.",
    inputSchema: {
        type: "object",
        properties: {
            media_id: {
                type: "string",
                description: "The media_id of the draft to edit.",
            },
            index: {
                type: "number",
                description: "Article index within the draft (0-based). Defaults to 0.",
            },
            image: {
                type: "string",
                description: "Local path or URL of the new cover thumbnail image.",
            },
        },
        required: ["media_id", "image"],
    },
} as const;

export async function replaceArticleCover(args: Record<string, any>) {
    const mediaId = String(args.media_id || "");
    if (!mediaId) {
        throw new Error("media_id 是必填项");
    }
    const image = String(args.image || "");
    if (!image) {
        throw new Error("image 是必填项（本地路径或 URL）");
    }
    const index = toIndex(args.index);

    const newsItems = await getDraftNewsItems(mediaId);
    const existing = newsItems[index];
    if (!existing) {
        throw new Error(`草稿 index=${index} 不存在（该草稿共有 ${newsItems.length} 篇文章）`);
    }

    const token = await getAccessToken();
    const uploaded = await uploadImageFromSource(image, token);
    if (!uploaded.media_id) {
        throw new Error(
            "封面缩略图必须上传为永久素材并获得 media_id；传入已是 mmbiz.qpic.cn 的 URL 无法用作缩略图，请提供本地文件或外部 URL。",
        );
    }

    await updateDraft(mediaId, index, mergeArticle(existing, { thumb_media_id: uploaded.media_id }));
    return buildMcpResponse(
        `封面缩略图已替换（media_id=${mediaId}, index=${index}, thumb_media_id=${uploaded.media_id}）。`,
    );
}
