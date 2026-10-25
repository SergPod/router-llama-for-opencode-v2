/**
 * TUI-часть плагина llama.cpp router: ОДНА команда с диалогом выбора.
 *
 *   /router-llama          список моделей роутера -> выбрать -> загрузить -> чат на неё
 *   /router-llama <имя>    то же самое по имени модели, без диалога
 *   Ctrl+U в диалоге       выгрузить выбранную модель
 *
 * Адрес и ключ берутся из провайдера "router-llama", объявленного в opencode.jsonc
 * (серверная часть плагина его не создаёт), поэтому файл параметров плагину не нужен.
 *
 * Роутер запущен с --no-models-autoload (llmr.bat): сам он модели не грузит. Плагин
 * отправляет POST /models/load / /models/unload ТОЛЬКО после выбора пользователя в
 * диалоге (или явного имени модели аргументом команды) и ждёт итогового статуса.
 * Провал загрузки: роутер при крахе инстанса оставляет "unloaded" и ставит
 * status.failed + status.exit_code — без проверки failed плагин молчал бы до таймаута.
 *
 * Загруженную модель плагин подставляет в текущую сессию (session.switchModel), иначе
 * чат остался бы на прежней модели и старом адресе. Наблюдатель watcher догружает
 * модель, если пользователь выбрал незагруженную в /models напрямую.
 *
 * Импортируется только @opencode/plugin/tui: OpenCode разрешает этот импорт сам.
 */

import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"

const DEBUG_LOG = "C:\\Users\\Serg\\AppData\\Local\\Temp\\opencode\\router-llama-tui.log"

/** Диагностический журнал TUI-части: виден в файле, в чат ничего не пишет. */
function debug(message: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Журнал не важен - команду это не останавливает.
  }
}

type RouterModel = { id: string; state: string; context: number; failed: boolean; exitCode?: number }

/** Итог ожидания: чем закончилась загрузка/выгрузка. */
type Outcome = { state: string; failed: boolean; exitCode?: number; timedOut: boolean }

type RouterTarget = { location: any; root: string; apiKey?: string }

const PROVIDER_ID = "router-llama"
const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1"
const LOAD_TIMEOUT_MS = 300_000
const UNLOAD_TIMEOUT_MS = 60_000
const READY_STATES = new Set(["loaded", "sleeping"])
const BUSY_STATES = new Set(["loading", "shifting", "unloading"])
const POLL_MS = 1000
const WATCH_MS = 20_000
/**
 * Сколько ждать после POST /models/load, прежде чем считать failed=true признаком
 * текущего провала: роутер сохраняет failed от прошлого краха, поэтому сразу после
 * запроса он ещё может быть от прошлой попытки.
 */
const STALE_FAILED_GRACE_MS = 20_000

function rootOf(baseURL: string): string {
  const trimmed = String(baseURL ?? "").replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed
}

/** Порт роутера для короткой подписи диалога: http://127.0.0.1:9931 -> 9931. */
function portOf(root: string): string {
  const matches = String(root ?? "").match(/:(\d+)/)
  return matches ? matches[1] : "?"
}

/** 204800 -> "200k": контекст одной короткой меткой, чтобы влезало в строку списка. */
function shortContext(context: number): string {
  if (!(context > 0)) return ""
  const k = Math.round(context / 1024)
  return k >= 1000 ? `${(k / 1000).toFixed(1).replace(/\.0$/, "")}M` : `${k}k`
}

/**
 * Контекст из имени файла (…_128k, …-200k): роутер сообщает n_ctx только для
 * загруженных моделей. "150k_C0" — после k идёт "_", поэтому \b не подходит.
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

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    loaded: "в памяти",
    unloaded: "не загружена",
    loading: "загружается",
    sleeping: "спит (в памяти)",
    shifting: "перезапускается",
    unloading: "выгружается",
    downloading: "качается",
    incomplete: "не докачана",
  }
  return labels[state] ?? state
}

/**
 * Код выхода упавшего инстанса - только то, что уже прислал роутер, без сторонних
 * утилит и без догадок о причине.
 */
function exitCodeHint(code?: number): string {
  if (code === undefined) return "инстанс роутера завершился"
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
  return `инстанс роутера завершился с кодом ${code} (${hex})`
}

/** Загруженные и спящие — наверх списка, остальные по алфавиту, упавшие — на дно. */
function rank(model: RouterModel): number {
  if (READY_STATES.has(model.state)) return 0
  if (model.failed) return 2
  return 1
}

function compare(a: RouterModel, b: RouterModel): number {
  return rank(a) - rank(b) || a.id.localeCompare(b.id)
}

async function request(
  url: string,
  apiKey: string | undefined,
  init?: RequestInit,
): Promise<{ status: number; json?: any } | undefined> {
  try {
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) }
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`
      headers["x-api-key"] = apiKey
    }
    const response = await fetch(url, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(8000) })
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

/** Адрес и ключ роутера - из провайдера "router-llama" (запись opencode.jsonc). */
async function routerTarget(ctx: any, providerID: string): Promise<RouterTarget> {
  const location = ctx.location ?? ctx.data.location.default()
  let baseURL = DEFAULT_BASE_URL
  let apiKey: string | undefined
  try {
    await ctx.data.location.provider.sync(location)
    const providers: any[] = ctx.data.location.provider.list(location) ?? []
    const provider = providers.find((entry) => entry?.id === providerID)
    if (typeof provider?.settings?.baseURL === "string") baseURL = provider.settings.baseURL
    if (typeof provider?.settings?.apiKey === "string") apiKey = provider.settings.apiKey
  } catch {
    // Провайдера ещё нет - остаётся адрес по умолчанию.
  }
  return { location, root: rootOf(baseURL), apiKey }
}

async function listModels(router: RouterTarget): Promise<{ models: RouterModel[]; status: number | undefined }> {
  const list = await request(`${router.root}/models`, router.apiKey)
  const data: any[] = Array.isArray(list?.json?.data) ? list.json.data : []
  const seen = new Set<string>()
  const models: RouterModel[] = []
  for (const entry of data) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : ""
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const state = typeof entry?.status?.value === "string" ? entry.status.value : "unknown"
    const context = Number(entry?.meta?.n_ctx ?? entry?.n_ctx ?? 0) || contextFromName(id)
    // Провал загрузки роутер помечает здесь же, оставляя state = "unloaded".
    const exit = Number(entry?.status?.exit_code)
    models.push({
      id,
      state,
      context: Number.isFinite(context) ? context : 0,
      failed: entry?.status?.failed === true,
      exitCode: Number.isFinite(exit) ? exit : undefined,
    })
  }
  return { models, status: list?.status }
}

function resolve(models: readonly RouterModel[], wanted: string): RouterModel | undefined {
  const needle = wanted.trim().toLowerCase()
  if (needle.length === 0) return undefined
  const exact = models.find((model) => model.id.toLowerCase() === needle)
  if (exact) return exact
  const partial = models.filter((model) => model.id.toLowerCase().includes(needle))
  return partial.length === 1 ? partial[0] : undefined
}

export default Plugin.define({
  id: "local.router-llama.tui",

  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const providerID = typeof options.providerID === "string" ? options.providerID : PROVIDER_ID

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", duration?: number) =>
      ctx.ui.toast.show({
        title: "llama.cpp router",
        message,
        variant,
        // Ошибку читают дольше: в ней код выхода из ответа роутера.
        duration: duration ?? (variant === "error" ? 15000 : variant === "warning" ? 10000 : 6000),
      })

    /**
     * ID сессии, в которой работает TUI: маршрут сессии -> активная вкладка -> последняя
     * открытая вкладка -> самая свежая сессия. Возвращает ТОЛЬКО строку ID: по типу V2
     * элемент вкладки — объект { sessionID, active, busy, ... }, и без извлечения в URL
     * попадал "/api/session/[object Object]/model" с ответом 400.
     */
    const asID = (value: unknown): string | undefined => {
      if (typeof value === "string") return value.trim().length > 0 ? value.trim() : undefined
      if (value && typeof value === "object") {
        const entry = value as Record<string, unknown>
        for (const key of ["sessionID", "id"]) {
          const candidate = entry[key]
          if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim()
        }
      }
      return undefined
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route: any = ctx.ui.router.current?.()
        // V2: { type: "session", sessionID }
        const fromRoute = asID(route?.type === "session" ? route : undefined)
        if (fromRoute) return fromRoute
        // Старая форма: { name: "session", params: { sessionID } }
        if (route?.name === "session" && route?.params) {
          const legacy = asID(route.params.sessionID ?? route.params.id)
          if (legacy) return legacy
        }
      } catch {
        // маршрут не сессионный - идём дальше
      }
      try {
        const tabs: any[] = ctx.ui.tabs?.enabled?.() ? (ctx.ui.tabs.list() as any[]) : []
        if (Array.isArray(tabs) && tabs.length > 0) {
          const active = tabs.find((tab: any) => tab?.active === true)
          const fromTab = asID(active ?? tabs[tabs.length - 1])
          if (fromTab) return fromTab
        }
      } catch {
        // вкладок нет
      }
      try {
        const sessions: any[] = ctx.data.session.list() ?? []
        const newest = sessions
          .filter((session) => typeof session?.id === "string")
          .slice()
          .sort((left, right) => (right?.time?.updated ?? 0) - (left?.time?.updated ?? 0))
        const fromList = asID(newest[0])
        if (fromList) return fromList
      } catch {
        // списка сессий нет
      }
      return undefined
    }

    /**
     * Сессия для переключения: текущая, а если её нет (домашний экран opencode) —
     * создаёт новую: иначе загрузка прошла, а чат переключить некуда.
     */
    const sessionForSwitch = async (): Promise<{ id: string; created: boolean }> => {
      const id = currentSessionID()
      if (id) return { id, created: false }
      const create = typeof ctx.client?.session?.create
      if (create === "function") {
        try {
          const created: any = await (ctx.client.session as any).create({})
          const newID = asID(created?.id ?? created)
          if (newID) {
            debug(`switch: сессии не было, создана новая ${newID}`)
            // Домашний экран -> новая вкладка сессии, чтобы переключение было видно.
            try {
              ctx.ui.router.navigate?.("session", { sessionID: newID })
            } catch {
              // навигация не удалась — сессия всё равно переключится
            }
            return { id: newID, created: true }
          }
        } catch (error: any) {
          debug(`switch: создание сессии не удалось: ${String(error?.message ?? error)}`)
        }
      }
      return { id: "", created: false }
    }

    /** Итог переключения чата: удалось ли и что показать пользователю. */
    type SwitchResult = { ok: boolean; text: string }

    /**
     * Переключает чат на загруженную модель роутера и ПРОВЕРЯЕТ результат: читает модель
     * сессии (data.session.get) и модель в строке ввода (ui.model.current). Без проверки
     * плагин молчал: запрос уходил, сервер отвечал 400, а в интерфейсе не появлялось ничего.
     */
    const useInChat = async (router: RouterTarget, id: string): Promise<SwitchResult> => {
      const port = portOf(router.root)
      const { id: sessionID, created } = await sessionForSwitch()
      if (!sessionID) {
        debug("switch: сессия не найдена и создать не удалось (route/tabs/session.list пустые)")
        return {
          ok: false,
          text: `"${id}" в памяти, но сессию определить/создать не удалось. Выберите модель в /models вручную`,
        }
      }
      const callable = typeof ctx.client?.session?.switchModel
      if (callable !== "function") {
        debug(`switch: ctx.client.session.switchModel отсутствует (typeof=${callable})`)
        return {
          ok: false,
          text: `"${id}" в памяти, но OpenCode не дал session.switchModel (typeof=${callable}). Выберите модель в /models`,
        }
      }
      try {
        await ctx.client.session.switchModel({ sessionID, model: { providerID, id } })
        debug(`switch: ок session=${sessionID} model=${providerID}/${id}`)
      } catch (error: any) {
        const reason = String(error?.message ?? error)
        debug(`switch: ошибка session=${sessionID} model=${providerID}/${id}: ${reason}`)
        return { ok: false, text: `переключить чат на "${id}" не удалось: ${reason}` }
      }
      // Обновляем данные сессии, чтобы поле модели в строке ввода показало новую модель.
      try {
        ctx.data.session.invalidate?.(sessionID)
        await ctx.data.session.sync?.(sessionID)
      } catch {
        // Данные обновит синхронизация TUI сама.
      }
      let stored: { providerID: string; id: string } | undefined
      try {
        const model: any = (ctx.data.session.get?.(sessionID) as any)?.model
        if (model) stored = { providerID: String(model.providerID ?? ""), id: String(model.id ?? model.modelID ?? "") }
      } catch {
        // модель сессии прочитать не удалось
      }
      let prompt: { providerID: string; id: string } | undefined
      try {
        const current: any = ctx.ui.model.current?.()
        if (current)
          prompt = { providerID: String(current.providerID ?? ""), id: String(current.modelID ?? current.id ?? "") }
      } catch {
        // модель в строке ввода прочитать не удалось
      }
      const same = (value?: { providerID: string; id: string }) => value?.providerID === providerID && value?.id === id
      debug(
        `switch: check session=${sessionID} сессия=${stored ? `${stored.providerID}/${stored.id}` : "нет"} ` +
          `строка_ввода=${prompt ? `${prompt.providerID}/${prompt.id}` : "нет"}`,
      )
      if (same(stored) && same(prompt))
        return { ok: true, text: created ? `создана сессия, подключено ${id}: ${providerID} -> :${port}` : `подключено ${id}: ${providerID} -> :${port}` }
      if (same(stored))
        return {
          ok: true,
          text:
            `подключено ${id}: ${providerID} -> :${port}` +
            (created ? " (создана новая сессия)" : ` (в строке ввода ещё ${prompt ? `${prompt.providerID}/${prompt.id}` : "ничего"}, обновится само)`),
        }
      return {
        ok: false,
        text: `запрос на "${id}" принят, но сессия показывает ${stored ? `${stored.providerID}/${stored.id}` : "ничего"}. Выберите модель в /models`,
      }
    }

    /**
     * Ждём итогового статуса модели и сообщаем, чем кончилось: успех, провал
     * (status.failed у роутера) или таймаут. Провал ловим сразу - роутер при крахе
     * оставляет "unloaded", так что ждать "loaded" до таймаута означало бы молчать
     * все минуты ожидания.
     */
    const waitFor = async (
      router: RouterTarget,
      id: string,
      wanted: readonly string[],
      timeoutMs: number,
    ): Promise<Outcome> => {
      const start = Date.now()
      const initial = await listModels(router)
      const initialFailed = initial.models.find((model) => model.id === id)?.failed === true

      let state = "unknown"
      let failed = initialFailed
      let exitCode: number | undefined
      let sawBusy = false
      let timedOut = true

      while (Date.now() - start < timeoutMs) {
        const probe = await listModels(router)
        const model = probe.models.find((entry) => entry.id === id)
        state = model?.state ?? "unknown"
        failed = model?.failed === true
        exitCode = model?.exitCode
        if (BUSY_STATES.has(state)) sawBusy = true

        if (wanted.includes(state)) {
          timedOut = false
          break
        }
        // failed появился впервые - это провал текущей попытки.
        if (failed && !initialFailed) break
        // Инстанс успел запуститься и вернулся в "unloaded" с failed -> упал.
        if (sawBusy && state === "unloaded" && failed) break
        // Инстанс не показал "loading", а failed уже стоял от прошлой попытки:
        // даём короткую паузу и считаем провалом текущего запроса.
        if (!sawBusy && failed && state === "unloaded" && Date.now() - start > STALE_FAILED_GRACE_MS) break

        await new Promise((sleep) => setTimeout(sleep, POLL_MS))
      }

      try {
        ctx.data.location.model.invalidate(router.location)
        await ctx.data.location.model.sync(router.location)
      } catch {
        // Список обновит серверный плагин своим reload.
      }
      return { state, failed, exitCode, timedOut }
    }

    /** Сообщение о провале загрузки: факт + код выхода из ответа роутера, ничего лишнего. */
    const failureText = (id: string, outcome: Outcome, timeoutMs: number): string => {
      if (outcome.timedOut) {
        return (
          `загрузка "${id}" не удалась: не завершилась за ${Math.round(timeoutMs / 1000)} с` +
          `, последний статус "${stateLabel(outcome.state)}"${outcome.failed ? `, ${exitCodeHint(outcome.exitCode)}` : ""}` +
          `. Модель осталась выгруженной, чат не переключён`
        )
      }
      return `загрузка "${id}" не удалась. ${exitCodeHint(outcome.exitCode)}. Модель осталась выгруженной, чат не переключён`
    }

    /**
     * Причина отказа из тела ответа роутера: llama.cpp пишет её в поля error/message.
     * Больше ничего не извлекаем: сторонние утилиты и оценка памяти не используются.
     */
    const routerErrorText = (json: any): string => {
      if (!json) return ""
      const candidates = [json.error, json.message, json.detail, typeof json === "string" ? json : undefined]
      for (const value of candidates) {
        if (typeof value !== "string") continue
        const line = value.split("\n").map((part) => part.trim()).filter((part) => part.length > 0)[0] ?? ""
        if (line.length > 0) return line.length > 220 ? `${line.slice(0, 220)}...` : line
      }
      return ""
    }

    const send = async (router: RouterTarget, endpoint: "load" | "unload", id: string) =>
      request(`${router.root}/models/${endpoint}`, router.apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
      })

    /** Выгрузка по Ctrl+U в диалоге: диалог она не закрывает, только тост. */
    const unload = async (router: RouterTarget, id: string) => {
      const result = await send(router, "unload", id)
      if (result?.json?.success !== true) {
        toast(`выгрузка "${id}" не принята (статус ${result?.status ?? "?"})`, "error")
        return
      }
      toast(`выгрузка "${id}": ок`)
      const outcome = await waitFor(router, id, ["unloaded"], UNLOAD_TIMEOUT_MS)
      debug(`unload: ${id} -> state=${outcome.state} failed=${outcome.failed} timedOut=${outcome.timedOut}`)
      if (outcome.timedOut) toast(`выгрузка "${id}" не завершилась (статус "${stateLabel(outcome.state)}")`, "warning")
      // Если чат продолжит обращаться к выгруженной модели, роутер ответит ошибкой.
      try {
        const current = ctx.ui.model.current?.()
        const used = current?.modelID ?? current?.id
        if (used === id) toast(`чат всё ещё указывает на "${id}" - выберите в /models другую модель`, "warning")
      } catch {
        // Текущую модель прочитать не удалось - предупреждение не показываем.
      }
    }

    const load = async (router: RouterTarget, chosen: RouterModel) => {
      // Модель уже в памяти: второй раз грузить не нужно, достаточно переключить чат.
      if (READY_STATES.has(chosen.state)) {
        const switched = await useInChat(router, chosen.id)
        toast(switched.text, switched.ok ? "success" : "info")
        return
      }

      const result = await send(router, "load", chosen.id)
      debug(`load: POST /models/load ${chosen.id} -> status=${result?.status} success=${result?.json?.success}`)
      if (result?.json?.success !== true) {
        // Роутер пишет причину отказа в теле ответа: её и показываем, без сторонних утилит.
        const reason = routerErrorText(result?.json)
        toast(
          `загрузка "${chosen.id}" не принята роутером (статус ${result?.status ?? "?"})` +
            `${reason ? `: ${reason}` : ". Ответ роутера пустой"}`,
          "error",
        )
        return
      }
      toast(`загружается "${chosen.id}" ...`)
      const outcome = await waitFor(router, chosen.id, ["loaded", "sleeping"], LOAD_TIMEOUT_MS)
      debug(
        `wait: ${chosen.id} -> state=${outcome.state} failed=${outcome.failed} exit=${outcome.exitCode} timedOut=${outcome.timedOut}`,
      )

      if (outcome.failed || outcome.timedOut || !READY_STATES.has(outcome.state)) {
        toast(failureText(chosen.id, outcome, LOAD_TIMEOUT_MS), "error")
        return
      }

      const switched = await useInChat(router, chosen.id)
      toast(
        switched.ok
          ? switched.text
          : `${switched.text} (модель "${chosen.id}" в памяти, статус "${stateLabel(outcome.state)}")`,
        switched.ok ? "success" : "warning",
      )
    }

    const run = async (argument?: string) => {
      const router = await routerTarget(ctx, providerID)
      const probe = await listModels(router)
      debug(
        `run: root=${router.root} key=${router.apiKey ? "yes" : "no"} models=${probe.models.length} failed=${probe.models.filter((model) => model.failed).length} status=${probe.status}`,
      )

      if (probe.models.length === 0) {
        toast(
          probe.status === 401
            ? `${router.root}: роутер требует ключ — проверьте apiKey провайдера "${providerID}" в opencode.jsonc`
            : `${router.root}: роутер не отвечает (запустите llama-server в режиме роутера, без -m)`,
          "error",
        )
        return
      }

      let chosen: RouterModel | undefined
      if (argument && argument.trim().length > 0) {
        chosen = resolve(probe.models, argument)
        if (!chosen) {
          toast(`не найдено по имени "${argument}". /llama-router без аргумента покажет список`, "error")
          return
        }
      } else {
        // Загруженные наверх, дальше по алфавиту.
        const models = probe.models.slice().sort(compare)
        // Заголовок короткий: диалог узкий, длинный заголовок наезжает на подсказку esc.
        const picked = await ctx.ui.dialog.select({
          title: `llama.cpp router :${portOf(router.root)} - загрузить модель`,
          options: models.map((model) => ({
            title: model.id,
            value: model.id,
            // Категория уже показывает состояние, поэтому в описании только контекст.
            description: shortContext(model.context),
            category: model.failed ? "сбой" : stateLabel(model.state),
            rank: rank(model),
          })),
          search: (query: string, items: any[]) =>
            items
              .filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
              .slice()
              .sort(
                (left: any, right: any) =>
                  (left.rank ?? 0) - (right.rank ?? 0) || left.title.localeCompare(right.title),
              ),
          actions: [
            {
              bind: "ctrl+u",
              title: "Выгрузить",
              side: "right" as const,
              onTrigger: (value: string) => void unload(router, value),
            },
          ],
        })
        if (!picked) return
        chosen = probe.models.find((model) => model.id === picked)
      }

      if (!chosen) return
      await load(router, chosen)
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "router.llama.pick",
          title: "llama.cpp router: список моделей -> загрузить и подставить в чат (Ctrl+U выгрузить)",
          group: "llama.cpp",
          palette: true,
          slash: { name: "router-llama", aliases: [], arguments: true },
          run: (input?: string) => run(input),
        },
      ],
    }))

    /**
     * Роутер с --no-models-autoload: пока в строке ввода стоит модель провайдера
     * router-llama, следим за её статусом. Модель выгрузили (--models-max 1 выгружает
     * сам при загрузке другой) — предупреждаем один раз на событие. Пользователь
     * выбрал незагруженную модель в /models напрямую — догружаем её сами.
     */
    let watchTarget: RouterTarget | undefined
    const warned = new Set<string>()
    const watcher = setInterval(async () => {
      try {
        const current: any = ctx.ui.model.current?.()
        const modelID = current?.modelID ?? current?.id
        if (current?.providerID !== providerID || typeof modelID !== "string" || modelID.length === 0) return
        const router = watchTarget ?? (await routerTarget(ctx, providerID))
        watchTarget = router
        const probe = await listModels(router)
        const model = probe.models.find((entry) => entry.id === modelID)
        if (!model) return
        if (READY_STATES.has(model.state)) {
          warned.delete(modelID)
          return
        }
        if (BUSY_STATES.has(model.state)) return
        // Модель не в памяти — автоматически загружаем её.
        debug(`watch: ${modelID} -> ${model.state}: не в памяти, запускаем загрузку`)
        toast(`загружается "${modelID}" ...`)
        const result = await send(router, "load", modelID)
        if (result?.json?.success !== true) {
          const reason = routerErrorText(result?.json)
          toast(
            `загрузка "${modelID}" не принята роутером (статус ${result?.status ?? "?"})` +
              `${reason ? `: ${reason}` : ". Ответ роутера пустой"}`,
            "error",
          )
          return
        }
        const outcome = await waitFor(router, modelID, ["loaded", "sleeping"], LOAD_TIMEOUT_MS)
        if (outcome.failed || outcome.timedOut || !READY_STATES.has(outcome.state)) {
          toast(failureText(modelID, outcome, LOAD_TIMEOUT_MS), "error")
          return
        }
        warned.delete(modelID)
        toast(`подключено ${modelID}: ${providerID} -> :${portOf(router.root)}`, "success")
      } catch {
        // роутер не отвечает - в этом проходе ничего не решаем
      }
    }, WATCH_MS)

    // Видимый признак того, что TUI-часть плагина действительно загрузилась.
    ctx.ui.toast.show({
      title: "llama.cpp router",
      message: "команда /router-llama: выбрать модель -> загрузить и подставить в чат",
      variant: "info",
      duration: 5000,
    })

    return () => clearInterval(watcher)
  },
})
