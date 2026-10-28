<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as fabric from 'fabric';
import { enliven } from '../../whiteboard/objects';
import { Connector, layoutConnector } from '../../whiteboard/connectors';
import type { ReplayObject } from '../../utils/replay';

/** Read-only render of one board's objects at a replay moment, fitted to the box. */
const props = defineProps<{ objects: ReplayObject[]; width: number; height: number }>();

const el = ref<HTMLCanvasElement | null>(null);
let canvas: fabric.StaticCanvas | null = null;
// Revived objects keyed by their JSON, so scrubbing only revives what actually changed
const cache = new Map<string, fabric.FabricObject>();
let renderId = 0;

async function render() {
  if (!canvas) return;
  const id = ++renderId;
  const sorted = [...props.objects].sort((a, b) => a.z - b.z);
  const revived: { id: string; obj: fabric.FabricObject }[] = [];
  for (const o of sorted) {
    const key = `${o.id}:${JSON.stringify(o.fabric)}`;
    let obj = cache.get(key);
    if (!obj) {
      obj = (await enliven(o.fabric)) || undefined;
      if (obj) cache.set(key, obj);
    }
    if (obj) revived.push({ id: o.id, obj });
  }
  if (id !== renderId || !canvas) return; // a newer render started meanwhile

  const byId = new Map(revived.map(r => [r.id, r.obj]));
  revived.forEach(r => r.obj instanceof Connector && layoutConnector(r.obj, oid => byId.get(oid)));

  canvas.clear();
  canvas.backgroundColor = '#f8fafc';
  revived.forEach(r => canvas!.add(r.obj));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { obj } of revived) {
    obj.setCoords();
    const b = obj.getBoundingRect();
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.left + b.width);
    maxY = Math.max(maxY, b.top + b.height);
  }
  if (revived.length) {
    const m = 30;
    const scale = Math.min(props.width / (maxX - minX + m * 2), props.height / (maxY - minY + m * 2), 1.5);
    const ox = (props.width - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = (props.height - (maxY - minY) * scale) / 2 - minY * scale;
    canvas.setViewportTransform([scale, 0, 0, scale, ox, oy]);
  }
  canvas.renderAll();
  // Images load asynchronously after reviving
  setTimeout(() => id === renderId && canvas?.requestRenderAll(), 400);
}

let pending: ReturnType<typeof setTimeout> | undefined;
const schedule = () => {
  clearTimeout(pending);
  pending = setTimeout(render, 80);
};

onMounted(() => {
  canvas = new fabric.StaticCanvas(el.value!, { width: props.width, height: props.height, renderOnAddRemove: false, enableRetinaScaling: true });
  render();
});
watch(() => props.objects, schedule);
watch(() => [props.width, props.height], () => {
  canvas?.setDimensions({ width: props.width, height: props.height });
  schedule();
});
onBeforeUnmount(() => {
  clearTimeout(pending);
  canvas?.dispose();
  canvas = null;
});
</script>

<template>
  <canvas ref="el"></canvas>
</template>
