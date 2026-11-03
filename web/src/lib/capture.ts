// Camera + microphone capture → contract `frame` / `audio` messages.
import { link } from './socket'
import { useStore } from './store'

const tNow = () => (Date.now() - useStore.getState().startedAt) / 1000

/** Streams JPEG frames (≤ 960 px wide) from a <video> element at `fps` while `link.streaming`. */
export function startFrameStreaming(video: HTMLVideoElement, fps = 15) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })!
  const id = window.setInterval(() => {
    if (!link.streaming || video.readyState < 2 || !video.videoWidth) return
    if (link.backpressure > 1_500_000) return // drop frames under back-pressure
    const w = Math.min(960, video.videoWidth)
    const h = Math.round((video.videoHeight / video.videoWidth) * w)
    if (canvas.width !== w) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(video, 0, 0, w, h)
    const b64 = canvas.toDataURL('image/jpeg', 0.72).split(',')[1]
    link.send({ type: 'frame', t: +tNow().toFixed(3), jpeg_b64: b64 })
  }, 1000 / fps)
  return () => window.clearInterval(id)
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
}
registerProcessor('argonaut-tap', Tap)`

function toB64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Streams mono PCM16 @ 24 kHz in ~80 ms chunks while `link.streaming`. */
export async function startAudioStreaming(stream: MediaStream) {
  const rate = 24000
  const ac = new AudioContext({ sampleRate: rate })
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ac.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const src = ac.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ac, 'argonaut-tap')
  const chunk = Math.round(rate * 0.08)
  let acc = new Float32Array(chunk)
  let n = 0
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const d = e.data
    for (let i = 0; i < d.length; i++) {
      acc[n++] = d[i]
      if (n === chunk) {
        if (link.streaming) {
          const pcm = new Int16Array(chunk)
          for (let k = 0; k < chunk; k++) pcm[k] = Math.max(-1, Math.min(1, acc[k])) * 0x7fff
          link.send({ type: 'audio', t: +tNow().toFixed(3), pcm16_b64: toB64(pcm.buffer), rate })
        }
        acc = new Float32Array(chunk)
        n = 0
      }
    }
  }
  src.connect(node)
  return () => {
    src.disconnect()
    node.disconnect()
    void ac.close()
  }
}
