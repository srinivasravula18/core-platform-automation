// CPU pressure generator.
//
// Squeezes available CPU on the server box so a load profile running alongside
// it shows what happens at peak contention. Windows has no cgroup CPU quota, so
// contention is created honestly: N busy worker threads competing for cores,
// with a duty cycle so the pressure level is tunable rather than all-or-nothing.
import os from "os";
import { Worker, isMainThread, workerData } from "worker_threads";

const WORKER_SOURCE = `
  const { parentPort, workerData } = require("worker_threads");
  const { dutyCycle, endAt, sliceMs } = workerData;
  const busyMs = Math.max(1, Math.round(sliceMs * dutyCycle));
  const idleMs = Math.max(0, sliceMs - busyMs);
  const spin = (ms) => {
    const until = Date.now() + ms;
    let acc = 0;
    while (Date.now() < until) acc += Math.sqrt(Math.random() * 1e6);
    return acc;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    while (Date.now() < endAt) {
      spin(busyMs);
      if (idleMs > 0) await sleep(idleMs);
    }
    parentPort.postMessage("done");
  })();
`;

const run = async () => {
  const cores = os.cpus()?.length ?? 4;
  const requested = Number(process.env.PRESSURE_WORKERS ?? 0);
  const fraction = Number(process.env.PRESSURE_FRACTION ?? 0.75);
  const workers = Math.max(1, requested > 0 ? requested : Math.round(cores * fraction));
  const durationSeconds = Number(process.env.PRESSURE_DURATION_SECONDS ?? 120);
  const dutyCycle = Math.min(Math.max(Number(process.env.PRESSURE_DUTY_CYCLE ?? 0.9), 0.05), 1);
  const sliceMs = Number(process.env.PRESSURE_SLICE_MS ?? 50);
  const endAt = Date.now() + durationSeconds * 1000;

  console.log(
    `cpu-pressure: ${workers} worker(s) on ${cores} core(s), duty cycle ${(dutyCycle * 100).toFixed(0)}%, ${durationSeconds}s`
  );

  const pool = [];
  for (let index = 0; index < workers; index += 1) {
    pool.push(
      new Worker(WORKER_SOURCE, { eval: true, workerData: { dutyCycle, endAt, sliceMs } })
    );
  }

  let previous = cpuTotals();
  const reporter = setInterval(() => {
    const current = cpuTotals();
    const idleDelta = current.idle - previous.idle;
    const totalDelta = current.total - previous.total;
    previous = current;
    const used = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
    const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    console.log(`cpu-pressure: host cpu ${used.toFixed(1)}% · ${remaining}s remaining`);
  }, 5_000);

  await Promise.all(pool.map((worker) => new Promise((resolve) => worker.once("exit", resolve))));
  clearInterval(reporter);
  console.log("cpu-pressure: released");
};

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus() ?? []) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

if (isMainThread && !workerData) {
  run().catch((error) => {
    console.error(`cpu-pressure failed: ${error.message}`);
    process.exit(1);
  });
}
