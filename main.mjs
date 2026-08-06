import {
    Client as DiscordClient,
    GatewayIntentBits,
    Partials,
    Events,
    WebhookClient
} from 'discord.js'

import { Client as ConcrntClient, semantics, Schemas } from '@concrnt/worldlib'
import { InMemoryAuthProvider, InMemoryKVS, CDID, LoadKeyFromMnemonic } from '@concrnt/client'

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CONCRNT_SECRET = process.env.CONCRNT_SECRET
const CONCRNT_SERVER = process.env.CONCRNT_SERVER || "denken.concrnt.net"
const WEBHOOK_NAME = process.env.WEBHOOK_NAME || "Concrnt Bridge"
const CONCRNT_TIMELINE = process.env.CONCRNT_TIMELINE
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID

const concrntPrivatekey = CONCRNT_SECRET.includes(' ')
    ? LoadKeyFromMnemonic(CONCRNT_SECRET)?.privatekey
    : CONCRNT_SECRET
const concrntClient = await ConcrntClient.create(
    CONCRNT_SERVER,
    new InMemoryAuthProvider(concrntPrivatekey),
    new InMemoryKVS()
)
let webhookClient = undefined

const escapeMarkdownLinkText = (text) => String(text ?? 'media')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')

const isHttpUrl = (value) => {
    try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
    } catch (_) {
        return false
    }
}

const formatMarkdownLink = (label, url) => {
    if (!isHttpUrl(url)) return null
    return `[${escapeMarkdownLinkText(label)}](${url})`
}

const isDiscordPreviewableMedia = (media) => {
    return media.mediaType?.startsWith('image') || media.mediaType?.startsWith('video')
}

const sortMediasForDiscordPreview = (medias = []) => {
    const previewable = []
    const fallback = []

    for (const media of medias) {
        if (isDiscordPreviewableMedia(media)) {
            previewable.push(media)
        } else {
            fallback.push(media)
        }
    }

    return [...previewable, ...fallback]
}

const buildConcrntMediaLines = (medias = []) => {
    return sortMediasForDiscordPreview(medias)
        .map((media) => formatMarkdownLink(media.altText || media.mediaType || 'media', media.mediaURL))
        .filter(Boolean)
}

const BROWSER_LIKE_FILE_TYPES = new Map([
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif'],
    ['.mp4', 'video/mp4'],
    ['.mov', 'video/quicktime'],
    ['.webm', 'video/webm'],
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.wav', 'audio/wav'],
])

const getBrowserLikeFileType = (filename = '') => {
    const normalized = filename.toLowerCase()
    const extension = normalized.slice(normalized.lastIndexOf('.'))
    return BROWSER_LIKE_FILE_TYPES.get(extension) ?? ''
}

const getDiscordAttachmentMediaType = (attachment) => {
    const fileType = getBrowserLikeFileType(attachment.name)
    if (fileType) return fileType

    return null
}

const buildDiscordAttachmentPayload = (attachments) => {
    const medias = []
    const downloadLines = []

    for (const attachment of attachments.values()) {
        if (!isHttpUrl(attachment.url)) continue

        const mediaType = getDiscordAttachmentMediaType(attachment)
        if (!mediaType) {
            const downloadLine = formatMarkdownLink(
                attachment.name ? `📎 ${attachment.name}` : '📎',
                attachment.url
            )
            if (downloadLine) downloadLines.push(downloadLine)
            continue
        }

        medias.push({
            mediaURL: attachment.url,
            mediaType,
        })
    }

    return { medias, downloadLines }
}

const buildContentWithMediaLinks = (body, mediaLines) => {
    return [body, ...mediaLines].filter(Boolean).join('\n')
}

const convertDetailsToDiscordSpoilers = (content = '') => {
    return content.replace(
        /<details>\s*<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>/gi,
        (_, body) => `||\n${body.trim()}\n||`
    )
}

const timelineReader = await concrntClient.newTimelineReader()
timelineReader.haltUpdate = true

// haltUpdate中はTimelineReader内部の重複排除が効かないため自前で持つ
const seenMessageURIs = new Set()

timelineReader.onNewItem = (item) => {
    (async () => {
        console.log("Concrnt message:", item.href)
        if (!webhookClient) {
            console.log("Webhook client not ready")
            return
        }

        if (seenMessageURIs.has(item.href)) return
        seenMessageURIs.add(item.href)
        if (seenMessageURIs.size > 1000) {
            seenMessageURIs.delete(seenMessageURIs.values().next().value)
        }

        const msg = await concrntClient.getMessage(item.href)
        if (!msg) {
            console.log("Failed to load Concrnt message:", item.href)
            return
        }

        if (msg.author === concrntClient.ccid) {
            console.log("Ignoring own message")
            return
        }

        const mediaLines = buildConcrntMediaLines(msg.value.medias)
        const content = buildContentWithMediaLinks(convertDetailsToDiscordSpoilers(msg.value.body), mediaLines)

        if (!content) {
            console.log("Ignoring empty Concrnt message")
            return
        }

        await webhookClient.send({
            content,
            username: msg.authorProfile?.username,
            avatarURL: msg.authorProfile?.avatar,
        })
    })().catch((err) => {
        console.error("Failed to bridge Concrnt message:", err)
    })
}
await timelineReader.listen([CONCRNT_TIMELINE])

const discordClient = new DiscordClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ],
})

discordClient.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${discordClient.user.tag}`)

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)
    const hooks = await channel.fetchWebhooks().catch(() => null);
    const existing = hooks?.find(h => h.name === WEBHOOK_NAME);

    const hook = existing ?? await channel.createWebhook({ name: WEBHOOK_NAME })

    webhookClient = new WebhookClient({ id: hook.id, token: hook.token })
    console.log("Webhook client ready:", WEBHOOK_NAME)
})

discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    console.log(message);

    if (message.channelId !== DISCORD_CHANNEL_ID) return;

    const { medias, downloadLines } = buildDiscordAttachmentPayload(message.attachments)
    const content = buildContentWithMediaLinks(message.content, downloadLines)

    if (!content && medias.length === 0) {
        console.log("Ignoring empty Discord message")
        return
    }

    const timestamp = new Date()
    const key = semantics.post(
        concrntClient.ccid,
        'main',
        CDID.newFromString(content, timestamp).toString()
    )
    const document = {
        kind: 'record',
        key,
        schema: medias.length > 0 ? Schemas.mediaMessage : Schemas.markdownMessage,
        value: {
            body: content,
            ...(medias.length > 0 ? { medias } : {}),
            profileOverride: {
                username: message.author.username,
                avatar: message.author.displayAvatarURL({ forceStatic: false, size: 256 }),
            }
        },
        author: concrntClient.ccid,
        distributes: [CONCRNT_TIMELINE],
        createdAt: timestamp
    }
    // botはマスター鍵のみ(subkeyなし)なのでデフォルトのsubkey署名は使えない
    await concrntClient.api.commit(document, undefined, { useMasterkey: true })
});

discordClient.login(DISCORD_TOKEN);

