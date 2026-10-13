import type { Job, JobContext } from "../job.js";
import type { BreakPipeline } from "./pipeline.js";
import { type BreakRepo, dbStatusOf } from "./repo.js";

/** Advances every active break, and keeps the database's copy of the status in step with the chain. */
export function pipelineJob(deps: { pipeline: BreakPipeline; repo: BreakRepo; intervalMs: number }): Job {
  return {
    name: "pipeline",
    intervalMs: deps.intervalMs,
    async run(ctx: JobContext) {
      for (const active of await deps.repo.activeBreaks()) {
        try {
          const report = await deps.pipeline.advance(active);
          if (report.chainStatus) {
            const status = dbStatusOf(report.chainStatus);
            if (status !== active.status) await deps.repo.setStatus(active.id, status);
          }
          if (report.problem) {
            ctx.log.error("pipeline needs attention", { break: active.id, problem: report.problem });
          } else if (report.sent.length > 0 || report.waiting) {
            ctx.log.info("pipeline", {
              break: active.id,
              status: report.chainStatus,
              sent: report.sent.map((s) => s.step),
              waiting: report.waiting,
            });
          }
        } catch (err) {
          // One break must not hold up the others.
          ctx.log.error("pipeline: break failed", {
            break: active.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
