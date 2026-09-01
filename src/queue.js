/* One queue for every byte this app pulls just to look at something.
   Measured on the tailnet: ~35ms per webdav request (it is PHP) and plenty of bandwidth.
   So the enemy is not speed, it is a slot that never comes free: four big originals in
   flight and every thumbnail behind them waits for the slowest one. Hence three rules -
   a hard cap, a smaller cap on heavy pulls, and a watchdog so nothing holds a slot forever. */
/* Measured against this Nextcloud with parallel requests: 1 -> 147ms, 4 -> 215ms, 8 -> 228ms,
   16 -> 400ms, 24 -> 682ms. Eight is free; past that the PHP workers start queueing anyway. */
export const MAX_INFLIGHT = 8
export const MAX_HEAVY = 3
export const STALL_MS = 45000
export const PRI = { open: 0, thumb: 1, full: 2 }
const HEAVY = PRI.full

let inflight = 0
let heavy = 0
const queue = []

/** Lowest priority first, and inside one priority the smallest file first. */
function pick () {
  let best = -1
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i]
    if (j.pri === HEAVY && heavy >= MAX_HEAVY) continue
    const b = queue[best]
    if (best < 0 || j.pri < b.pri || (j.pri === b.pri && j.size < b.size)) best = i
  }
  return best < 0 ? null : queue.splice(best, 1)[0]
}

function pump () {
  while (inflight < MAX_INFLIGHT) {
    const j = pick()
    if (!j) return
    inflight++
    if (j.pri === HEAVY) heavy++
    let done = false
    const release = () => {
      if (done) return
      done = true
      inflight--
      if (j.pri === HEAVY) heavy--
      pump()
    }
    const watchdog = setTimeout(() => { j.no(new Error('timed out')); release() }, STALL_MS)
    j.run().then(j.ok, j.no).then(() => { clearTimeout(watchdog); release() })
  }
}

/** Run `fn` when a slot frees up. Lower pri goes first, smaller `size` first within a pri. */
export const gate = (pri, fn, size = 0) =>
  new Promise((ok, no) => { queue.push({ pri, run: fn, ok, no, size }); pump() })
export const busy = () => inflight
export const waiting = () => queue.length
