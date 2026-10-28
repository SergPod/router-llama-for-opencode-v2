/**
 * router-llama: серверная часть плагина (согласно docs opencode.ai/v2/build/plugins).
 *
 * Провайдер "router-llama" ОБЪЯВЛЕН в opencode.jsonc (npm @ai-sdk/openai-compatible,
 * options.baseURL + apiKey). Плагин не создаёт и не правит провайдер: он добавляет
 * в реестр список моделей роутера (GET /models, включая незагруженные). С чужими
 * провайдерами (в т.ч. "local") плагин не взаимодействует.
 *
 * Конфиг (opencode.jsonc) читается файлом на старте: адрес роутера и ключ известны
 * ДО первого provider.transform, и плагин не зависит от порядка
 * реестра. Запасные источники: опции плагина, переменные ROUTER_LLAMA_API_KEY /
 * LLAMA_API_KEY, значения по умолчанию.
 *
 * Режим роутера llama.cpp (llmr.bat: --no-models-autoload --models-preset --models-max 1):
 *   GET  /models        все модели + статусы   POST /models/load|unload {"model":"<id>"}
 * Загрузку/выгрузку делает пользователь в диалоге /router-llama (tui.ts); агенту
 * доступен только инструмент чтения списка (router_llama_list).
 *
 * Контекст модели берётся из фактов роутера: meta.n_ctx для загруженной, иначе из
 * имени пресета (…_128k) — каждый бэкенд стартует с --ctx-size из ini-пресета.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"
import { appendFileSync, readFileSync } from "node:fs"

const DEBUG_LOG = "C:\\Users\\Serg\\AppData\\Local\\Temp\\opencode\\router-llama-server.log"

/** Журнал серверной части: console.log в лог сервера не попадает, файл — да. */
function log(message: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [router-llama] ${message}\n`)
  } catch {
    // журнал не важен — плагин продолжает работать
  }
}

type ModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean }
  variants: unknown[]
  time: { released: number }
  cost: { input: number; output: number; cache: { read: number; write: number } }[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; output: number; input?: number }
}

type Discovered = { id: string; name: string; state: string; context: number }

const PROVIDER_ID = "router-llama"
const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1"
const DEFAULT_REFRESH_MS = 20_000
const KEY_ENV_NAMES = ["ROUTER_LLAMA_API_KEY", "LLAMA_API_KEY"]
const READY_STATES = new Set(["loaded", "sleeping"])

function rootOf(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

declare const process: { env?: Record<string, string | undefined> } | undefined

function env(key: string): string | undefined {
  try {
    const value = typeof process !== "undefined" && process ? process.env?.[key] : undefined
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  } catch {
    return undefined
  }
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1")
}

/**
 * Конфиг OpenCode как файл: ~/.config/opencode/opencode.jsonc (JSONC). Достаёт
 * опции провайдера "router-llama". Читаем сами, чтобы не зависеть
 * от того, в какой момент реестра выполняется transform.
 */
function readConfig(): {
  baseURL?: string
  apiKey?: string
  name?: string
  path?: string
} {
  const candidates = [
    env("XDG_CONFIG_HOME"),
    env("USERPROFILE"),
    env("HOME"),
  ]
    .filter((value): value is string => value !== undefined)
    .flatMap((home) => {
      const base = home.replace(/[\\/]+$/, "")
      return [`${base}/opencode/opencode.jsonc`, `${base}/.config/opencode/opencode.jsonc`]
    })
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(stripComments(String(readFileSync(path, "utf8"))))
      const providers: any = parsed?.provider ?? {}
      const router: any = providers[PROVIDER_ID]
      const routerOpts: any = router?.options ?? router?.settings ?? {}
      return {
        baseURL: str(routerOpts.baseURL),
        apiKey: str(routerOpts.apiKey),
        name: str(router?.name),
        path,
      }
    } catch {
      // файла нет или не читается — следующий кандидат
    }
  }
  return {}
}

/**
 * Контекст из имени файла: у моделей из --models-dir размер контекста обычно зашит
 * в имя (…_128k, …-200k). Роутер сообщает n_ctx только для загруженных моделей.
 * "150k_C0" — после k идёт "_", поэтому \b не подходит: запрет на следующую букву.
 */
function contextFromName(id: string): number {
  const matches = id.match(/(\d+(?:\.\d+)?)k(?![a-z])/gi) ?? []
  let best = 0
  for (const raw of matches) {
    const value = Number(raw.replace(/[^\d.]/g, ""))
    if (Number.isFinite(value) && value > best) best = value
  }
  return best > 0 ? Math.round(best * 1024) : 0
}

async function request(
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
): Promise<{ status: number; json?: any } | undefined> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
      signal: init?.signal ?? AbortSignal.timeout(8000),
    })
    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  } catch {
    return undefined
  }
}

function authHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) return {}
  // llama-server проверяет "Authorization: Bearer <ключ>"; x-api-key на всякий случай.
  return { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey }
}

/** GET /models роутера: все модели, включая незагруженные. */
async function probeRouter(root: string, apiKey?: string): Promise<Discovered[]> {
  const list = await request(`${root}/models`, authHeaders(apiKey))
  const data: any[] = Array.isArray(list?.json?.data) ? list.json.data : []
  const seen = new Set<string>()
  const models: Discovered[] = []
  for (const entry of data) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : ""
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const state = typeof entry?.status?.value === "string" ? entry.status.value : "unknown"
    const context = Number(entry?.meta?.n_ctx ?? entry?.n_ctx ?? 0) || contextFromName(id)
    // Имя = id секции пресета: ровно то, что уходит роутеру в поле model.
    models.push({ id, name: id, state, context: Number.isFinite(context) ? context : 0 })
  }
  return models
}

/**
 * Запись модели для реестра. Лимиты не снижаем искусственно: контекст берётся из
 * фактов роутера (n_ctx / имя пресета), остальное — разумные значения по умолчанию.
 */
function toModelInfo(entry: Discovered, providerID: string): ModelInfo {
  const model: ModelInfo = {
    id: "",
    modelID: "",
    providerID,
    name: "",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 8192, output: 4096 },
  }
  model.id = entry.id
  model.modelID = entry.id
  model.name = entry.name
  if (entry.context > 0) model.limit = { ...model.limit, context: entry.context }
  return model
}

export default Plugin.define({
  id: "local.router-llama",

  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const config = readConfig()
    const refreshMs = num(options.refreshMs) ?? DEFAULT_REFRESH_MS
    const state = {
      baseURL: str(options.baseURL) ?? config.baseURL ?? DEFAULT_BASE_URL,
      apiKey:
        str(options.apiKey) ??
        config.apiKey ??
        KEY_ENV_NAMES.map(env).find((value) => value !== undefined),
      models: [] as Discovered[],
      signature: "",
    }
    log(
      `setup: baseURL=${state.baseURL} key=${state.apiKey ? "есть" : "нет"}` +
        (config.path ? ` config=${config.path}` : " config не найден"),
    )

    const addProvider = (editor: any) => {
      const record: any = editor.get?.(PROVIDER_ID)
      // Провайдер объявлен в opencode.jsonc: переносим его info, подстраховываясь
      // на случай, если реестр ещё его не содержит (строим из конфига файла).
      let info: any
      if (record?.provider) {
        info = structuredClone(record.provider)
      } else {
        info = {
          ...(typeof Provider?.Info?.empty === "function" ? Provider.Info.empty(PROVIDER_ID) : {}),
          id: PROVIDER_ID,
          name: config.name ?? "llama-router",
          package: "@opencode/ai/providers/openai-compatible",
          activation: "enabled",
          settings: { baseURL: state.baseURL, ...(state.apiKey ? { apiKey: state.apiKey } : {}) },
          options: { baseURL: state.baseURL, ...(state.apiKey ? { apiKey: state.apiKey } : {}) },
        }
      }
      info.id = PROVIDER_ID
      info.activation = "enabled"
      info.description = `llama.cpp router ${rootOf(state.baseURL)}`
      const models = state.models.map((entry) => toModelInfo(entry, PROVIDER_ID))
      // Провайдер уже в реестре (из opencode.jsonc), но моделей нет — подставляем список.
      if (record?.models && typeof editor.models?.set === "function") {
        editor.models.set(PROVIDER_ID, models)
        log(`provider уже в реестре, моделей подставлено ${models.length}`)
        return
      }
      editor.add({ info, models })
      log(`provider добавлен, моделей ${models.length}`)
    }

    try {
      await ctx.provider.transform((editor: any) => {
        addProvider(editor)
      })
      log(`provider.transform зарегистрирован, моделей в реестр: ${state.models.length}`)
    } catch (error: any) {
      log(`provider.transform НЕ зарегистрирован: ${String(error?.message ?? error)}`)
    }

    // Инструмент агенту — только чтение списка. Загрузку делает пользователь в /llama-router.
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "router_llama_list",
          description: "Список моделей llama-server в режиме роутера и их статусы (только чтение)",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            const next = await probeRouter(rootOf(state.baseURL), state.apiKey)
            const width = Math.min(60, Math.max(1, ...next.map((model) => model.id.length)))
            const lines = next.map((m) => `${m.id.padEnd(width)}  ${m.state}`)
            return { content: `router ${rootOf(state.baseURL)}\n${lines.join("\n") || "список пуст"}` }
          },
        })
      })
    } catch (error: any) {
      log(`tool.transform НЕ зарегистрирован: ${String(error?.message ?? error)}`)
    }

    // Опрос роутера: статусы меняются (загрузили/выгрузили) — обновляем реестр.
    // Первый проход с паузой: transform должны успеть отработать.
    const sync = async () => {
      try {
        const next = await probeRouter(rootOf(state.baseURL), state.apiKey)
        const signature = next.map((model) => `${model.id}:${model.state}`).join("|")
        if (signature === state.signature) return
        state.signature = signature
        state.models = next
        const loaded = next.filter((model) => READY_STATES.has(model.state)).length
        log(`${rootOf(state.baseURL)}: моделей ${next.length}, в памяти ${loaded}`)
        await ctx.provider.reload()
      } catch (error: any) {
        log(`sync: ${String(error?.message ?? error)}`)
      }
    }
    const first = setTimeout(() => void sync(), 1500)
    const timer = setInterval(() => void sync(), refreshMs)

    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  },
})
