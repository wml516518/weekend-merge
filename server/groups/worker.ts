import type { AgentEvent } from '../../src/contracts/agent';
import type { ClaimedGroupJob } from '../../src/contracts/groups';
import { createDeepSeekModel } from '../../netlify/functions/agent/deepseek';
import { encodeAgentEvent } from '../../netlify/functions/agent/http';
import type { AgentModel } from '../../netlify/functions/agent/model';
import { runPlanningAgent } from '../../netlify/functions/agent/orchestrator';
import { validateRequestDate } from '../../netlify/functions/agent/requestProtection';
import { createAgentTools } from '../../netlify/functions/agent/tools/registry';
import { createWeatherTool } from '../../netlify/functions/agent/tools/weather';
import type { WeatherEnvironment } from '../../netlify/functions/agent/tools/qweather';
import { createReplanHandler } from '../../netlify/functions/replan';
import { GroupError } from './auth';
import type { GroupRepository } from './repository';

export type GroupRunner = (snapshot: Readonly<ClaimedGroupJob>, emit: (event: AgentEvent) => void) => Promise<void>;
export function createDefaultGroupRunner(options: {
  now?: () => Date;
  env?: { DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL?: string } & WeatherEnvironment;
  createModel?: (config: { apiKey: string; model: string }) => AgentModel;
} = {}): GroupRunner {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  // Only public weather data is shared; adapters/tool context are task-local.
  const weather = createWeatherTool({ now, env });
  return async (job, emit) => {
    if (validateRequestDate(job.request.setup.date, now())) {
      emit({ type: 'run.failed', code: 'INVALID_DATE', message: '出游日期已过期，请开始新一轮。' });
      return;
    }
    if (job.kind === 'replan') {
      if (!job.replanRequest) throw new Error('INVALID_STORED_REQUEST');
      const response = await createReplanHandler({ now })(new Request('http://localhost/internal-replan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.replanRequest),
      }));
      if (!response.ok) throw new Error('REPLAN_FAILED');
      for (const line of (await response.text()).trim().split('\n')) if (line) emit(encodeAgentEvent(JSON.parse(line)).event);
      return;
    }
    let model: AgentModel | undefined;
    if (env.DEEPSEEK_API_KEY?.trim()) {
      try { model = (options.createModel ?? createDeepSeekModel)({ apiKey: env.DEEPSEEK_API_KEY.trim(), model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash' }); }
      catch { /* Missing adapter is reported by the orchestrator as rule fallback. */ }
    }
    await runPlanningAgent(job.request, { now, model, tools: createAgentTools({ request: job.request, weather, now }), onEvent: emit });
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const publicCodes = new Set(['MODEL_UNAVAILABLE', 'INVALID_MODEL_RESULT', 'WEATHER_UNAVAILABLE', 'TOOL_UNAVAILABLE', 'TOOL_LIMIT_EXCEEDED', 'UNKNOWN_TOOL', 'DUPLICATE_TOOL_CALL_ID', 'INVALID_TOOL_ARGUMENTS', 'NO_VALID_PLAN', 'NO_VALID_REPLAN', 'INVALID_REQUEST', 'INVALID_DATE', 'INVALID_CATALOG', 'PLANNING_FAILED', 'BUDGET_EXCEEDED', 'NO_FEASIBLE_PLAN']);
const safeCode = (code: string) => publicCodes.has(code) ? code : 'PLANNING_FAILED';
function publicEvent(input: AgentEvent): AgentEvent {
  const { event } = encodeAgentEvent(input);
  if (event.type === 'run.failed') return { ...event, code: safeCode(event.code), message: '规划暂时无法完成，请稍后重试。' };
  if (event.type === 'run.degraded') return { type: 'run.degraded', reason: safeCode(event.reason), fallback: 'rule-planner' };
  if (event.type === 'tool.failed') return { ...event, code: safeCode(event.code) };
  return event;
}

export class GroupWorker {
  private readonly concurrency: number;
  private readonly run: GroupRunner;
  private readonly active = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private recovered = false;
  private stopping = false;
  private cleanedAt = 0;
  constructor(private readonly repo: GroupRepository, options: { concurrency?: number; run?: GroupRunner } = {}) {
    this.concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new Error('INVALID_CONCURRENCY');
    this.run = options.run ?? createDefaultGroupRunner();
  }
  start(): void {
    if (this.started || this.stopping) return;
    if (!this.recovered) { this.repo.recoverInterrupted(); this.recovered = true; }
    this.started = true;
    this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (Date.now() - this.cleanedAt >= 60_000) { this.repo.cleanup(); this.cleanedAt = Date.now(); }
    while (this.active.size < this.concurrency) {
      const job = this.repo.claimJob(this.concurrency); if (!job) break;
      // Start on a microtask so active capacity is reserved even for immediate completions.
      const task = Promise.resolve().then(() => this.execute(freeze(job))).finally(() => {
        this.active.delete(task);
        if (this.started && !this.stopping) void this.tick();
      });
      this.active.add(task);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true; this.started = false;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active]);
  }
  private async execute(job: ClaimedGroupJob): Promise<void> {
    let terminal: 'run.completed' | 'run.failed' | undefined;
    let failure = 'PLANNING_FAILED';
    try {
      await this.run(job, original => {
        if (terminal) throw new Error('EVENT_AFTER_TERMINAL');
        const event = publicEvent(original);
        this.repo.appendEvent(job.id, job.lease, event);
        if (event.type === 'run.completed' || event.type === 'run.failed') terminal = event.type;
        if (event.type === 'run.failed') failure = safeCode(event.code);
      });
      if (terminal !== 'run.completed') throw new Error('INCOMPLETE_RESULT');
      this.repo.finishJob(job.id, job.lease, 'succeeded');
    } catch (error) {
      // A revision change, expiry or recovery fences every late event/result.
      if (error instanceof GroupError && ['STALE_LEASE', 'GROUP_UNAVAILABLE'].includes(error.code)) return;
      try { this.repo.finishJob(job.id, job.lease, 'failed', failure); }
      catch (finishError) {
        if (!(finishError instanceof GroupError && ['STALE_LEASE', 'GROUP_UNAVAILABLE'].includes(finishError.code))) throw finishError;
      }
    }
  }
}
