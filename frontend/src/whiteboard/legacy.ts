import * as fabric from 'fabric';
import { StickyNote, assignBoardIdentity, serialize, type BoardObject } from './objects';

/**
 * Converts a v1 board (one Fabric JSON blob in message.metadata.whiteboardJson) into v2 objects.
 * Each object is restored on its own so one unknown custom object never loses the whole board;
 * old sticky notes (Textbox + isStickyNote) become StickyNote, everything else keeps its Fabric type.
 */
export async function convertLegacyBoard(json: string): Promise<{ id: string; z: number; fabric: Record<string, any> }[]> {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const raw: any[] = Array.isArray(data?.objects) ? data.objects : [];
  const out: { id: string; z: number; fabric: Record<string, any> }[] = [];

  for (let i = 0; i < raw.length; i++) {
    const src = raw[i];
    let obj: fabric.FabricObject | undefined;
    try {
      if (src?.isStickyNote) {
        obj = new StickyNote(src.text || '', {
          left: src.left, top: src.top, angle: src.angle || 0,
          originX: src.originX || 'center', originY: src.originY || 'center',
          width: Math.max(40, (src.width || 180) * (src.scaleX || 1) - 28),
          minHeight: Math.max(40, (src.height || 180) * (src.scaleY || 1) - 28),
          backgroundColor: src.backgroundColor, fill: src.fill, fontSize: src.fontSize || 18, textAlign: src.textAlign || 'left'
        });
      } else {
        [obj] = await fabric.util.enlivenObjects<fabric.FabricObject>([src]);
      }
    } catch (err) {
      console.warn('[whiteboard] skipped legacy object', src?.type, err);
    }
    if (!obj) continue;
    const boardObj: BoardObject = assignBoardIdentity(obj, i + 1);
    out.push({ id: boardObj.id, z: boardObj.z, fabric: serialize(boardObj) });
  }
  return out;
}
