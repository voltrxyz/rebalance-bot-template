import { isMainThread, parentPort } from "worker_threads";
import { MetricAction, MetricMessage } from "./metrics";

function postMetric(
  name: string,
  action: MetricAction,
  value: number,
  labels?: Record<string, string>
) {
  if (isMainThread) return;

  const msg: MetricMessage = { type: "metric", name, action, value, labels };
  parentPort?.postMessage(msg);
}

export const workerMetrics = {
  inc(name: string, labels?: Record<string, string>, value = 1) {
    postMetric(name, "inc", value, labels);
  },

  set(name: string, value: number, labels?: Record<string, string>) {
    postMetric(name, "set", value, labels);
  },

  observe(name: string, value: number, labels?: Record<string, string>) {
    postMetric(name, "observe", value, labels);
  },
};
