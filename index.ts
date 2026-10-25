/**
 * router-llama: серверная часть плагина (согласно docs opencode.ai/v2/build/plugins).
 *
 * Провайдер "router-llama" ОБЪЯВЛЕН в opencode.jsonc (npm @ai-sdk/openai-compatible,
 * options.baseURL + apiKey). Плагин не создаёт и не правит провайдер: он добавляет
 * в реестр список моделей роутера (GET /models, включая незагруженные) и снижает
 * лимиты модели "local". Секция "local" в opencode.jsonc не меняется.
 *
 * Конфиг (opencode.jsonc) читается файлом на старте: адрес роутера, ключ и адрес
 * "local" известны ДО первого provider.transform, и плагин не зависит от порядка
 * реестра. Запасные источники: опции плагина, переменные ROUTER_LLAMA_API_KEY /
 * LLAMA_API_KEY, значения по умолчанию.
 *
 * Режим роутера llama.cpp (llmr.bat: --no-models-autoload --models-preset --models-max 1):
 *   GET  /models        все модели + статусы   POST /models/load|unload {"model":"<id>"}
 *   GET  /v1/models     только загруженные     GET /health  публичный
 * Загрузку/выгрузку делает пользователь в диалоге /router-llama (tui.ts); агенту
 * доступен только инструмент чтения списка (router_llama_list).
 *
 * Лимиты local: в реестре заявлен контекст 200000, сервер держит max_context 131072
 * (читается из /health), и автосжатие начиналось по отказу сервера. Плагин снижает
 * limit.context/limit.output (потолок 16000) через ctx.model.transform.
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
const TEMPLATE_PROVIDER_ID = "local"
const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1"
const DEFAULT_LOCAL_URL = "http://127.0.0.1:8080/v1"
const DEFAULT_REFRESH_MS = 20_000
const OUTPUT_CAP = 16_000
const ROUTER_OUTPUT_CAP = 8_192
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
 * опции провайдера "router-llama" и адрес "local". Читаем сами, чтобы не зависеть
 * от того, в какой момент реестра выполняется transform.
 */
function readConfig(): {
  baseURL?: string
  apiKey?: string
  name?: string
  localBaseURL?: string
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
      const local: any = providers[TEMPLATE_PROVIDER_ID]
      const routerOpts: any = router?.options ?? router?.settings ?? {}
      const localOpts: any = local?.options ?? local?.settings ?? {}
      return {
        baseURL: str(routerOpts.baseURL),
        apiKey: str(routerOpts.apiKey),
        name: str(router?.name),
        localBaseURL: str(localOpts.baseURL),
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

/** max_context сервера "local" из публичного /health. 0 = прочитать не удалось. */
async function maxContextOf(baseURL: string): Promise<number> {
  const health = await request(`${rootOf(baseURL)}/health`, {})
  const value = Number(health?.json?.max_context ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
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

function toModelInfo(entry: Discovered, providerID: string, template: ModelInfo | undefined): ModelInfo {
  const clone = structuredClone(
    template ?? {
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
    },
  ) as ModelInfo
  clone.id = entry.id
  clone.modelID = entry.id
  clone.providerID = providerID
  clone.name = entry.name
  clone.enabled = true
  clone.status = "active"
  if (entry.context > 0) clone.limit = { ...clone.limit, context: entry.context }
  const output = Number(clone.limit?.output ?? 0)
  if (!(output > 0) || output > ROUTER_OUTPUT_CAP) clone.limit = { ...clone.limit, output: ROUTER_OUTPUT_CAP }
  return clone
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
      localBaseURL: str(options.localBaseURL) ?? config.localBaseURL ?? DEFAULT_LOCAL_URL,
      localMaxContext: 0,
      models: [] as Discovered[],
      template: undefined as ModelInfo | undefined,
      signature: "",
    }
    log(
      `setup: baseURL=${state.baseURL} key=${state.apiKey ? "есть" : "нет"} local=${state.localBaseURL}` +
        (config.path ? ` config=${config.path}` : " config не найден"),
    )

    const localProbe = async (): Promise<number> => {
      const value = await maxContextOf(state.localBaseURL)
      if (value > 0 && value !== state.localMaxContext) {
        log(`local ${state.localBaseURL}: max_context ${state.localMaxContext || "?"} -> ${value}`)
        state.localMaxContext = value
      }
      return value
    }

    // Шаблон модели и адрес "local" — из реестра, если уже есть; иначе из конфига файла.
    const ensureTemplate = (editor: any) => {
      const local: any = editor.get?.(TEMPLATE_PROVIDER_ID)
      const templateModel: any = local?.models?.values?.().next?.().value
      if (templateModel) state.template = structuredClone(templateModel) as ModelInfo
      const discovered =
        str(local?.provider?.settings?.baseURL) ?? str(local?.provider?.options?.baseURL)
      if (discovered) state.localBaseURL = discovered
    }

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
      const models = state.models.map((entry) => ({
        ...toModelInfo(entry, PROVIDER_ID, state.template),
        enabled: true,
      }))
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
        ensureTemplate(editor)
        addProvider(editor)
      })
      log(`provider.transform зарегистрирован, моделей в реестр: ${state.models.length}`)
    } catch (error: any) {
      log(`provider.transform НЕ зарегистрирован: ${String(error?.message ?? error)}`)
    }

    // Потолки limit у local/loaded-gguf: только снижаем, opencode.jsonc не меняется.
    try {
      await localProbe()
      await ctx.model.transform((editor: any) => {
        const contextCap = state.localMaxContext
        for (const model of editor.list?.(TEMPLATE_PROVIDER_ID) ?? []) {
          const provider = typeof model?.providerID === "string" ? model.providerID : undefined
          const id = typeof model?.id === "string" ? model.id : undefined
          if (provider !== TEMPLATE_PROVIDER_ID || !id) continue
          const output = Number(model?.limit?.output ?? 0)
          const context = Number(model?.limit?.context ?? 0)
          const nextOutput = output > OUTPUT_CAP ? OUTPUT_CAP : output
          const nextContext = contextCap > 0 && context > contextCap ? contextCap : context
          if (nextOutput === output && nextContext === context) continue
          editor.update(provider, id, (target: any) => {
            target.limit = { ...(target.limit ?? {}), output: nextOutput, context: nextContext }
          })
          log(`${provider}/${id}: limit.output ${output} -> ${nextOutput}, limit.context ${context} -> ${nextContext}`)
        }
      })
    } catch (error: any) {
      log(`model.transform НЕ зарегистрирован: ${String(error?.message ?? error)}`)
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
    // Сервер 8080 мог перезапуститься с другим ctx-size: порог автосжатия должен совпадать.
    const localTimer = setInterval(async () => {
      const previous = state.localMaxContext
      const live = await localProbe()
      if (live > 0 && live !== previous) await ctx.model.reload()
    }, refreshMs)

    return () => {
      clearTimeout(first)
      clearInterval(timer)
      clearInterval(localTimer)
    }
  },
})
