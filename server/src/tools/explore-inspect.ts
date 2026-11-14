// Looking at one finished answer: the pictures, what the painter measured, what happens when its controls and charts are
// worked, and the judge's reading. Shared by single prompts and by the turns of scripted conversations, so a measure is the
// same wherever the answer came from.

import type { ExploreDrive, ExploreGeometry, ExploreJudgement, ExploreResult } from '@conduit/language';
import type { DriveReply, Eyes, HarnessReply, HarnessRequest } from './explore-browser';
import { judgeStills } from './explore-rig';
import type { Rig } from './explore-rig';

export interface Inspected {
  readonly reply: HarnessReply;
  readonly geometry: ExploreGeometry;
  /** what working the controls and charts came to; null when the answer left none */
  readonly driven: DriveReply | null;
  readonly drive: ExploreDrive | null;
  /** settles when the judge has spoken */
  readonly judgement: Promise<ExploreJudgement | null>;
}

export function driveOf(driven: DriveReply, answered: boolean | null = null): ExploreDrive {
  return {
    controls: driven.controls.map((control) => ({ id: control.id, kind: control.kind, bound: control.bound, changed: control.changed, reported: control.reported, answered: control.kind === 'button' ? answered : null })),
    charts: driven.charts.map((chart) => ({ id: chart.id, crosshair: chart.crosshair, zoomed: chart.zoomed, silent: chart.silent })),
  };
}

/** Takes the pictures, measures, works the answer's controls and charts, and starts the judge. Throws what the page threw. */
export async function inspect(rig: Rig, eyes: Eyes, request: HarnessRequest, asked: string, answer: ExploreResult, wantJudge: boolean): Promise<Inspected> {
  const reply = await eyes.look(request);
  const hasControls = (answer.checks.controls ?? 0) > 0;
  const hasChart = answer.checks.chart != null;
  let driven: DriveReply | null = null;
  if (hasControls || hasChart) {
    try {
      driven = await eyes.drive({ turn: request.turn, base: request.base, lines: request.lines, viewport: request.viewport, side: 512 });
    } catch (error) {
      process.stderr.write(`explore: could not work the controls of ${request.turn}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const judgement = wantJudge ? judgeStills(rig, asked, reply, { chart: hasChart || answer.prompt.expects === 'chart', drive: driven }) : Promise.resolve(null);
  return { reply, geometry: reply.geometry, driven, drive: driven === null ? null : driveOf(driven), judgement };
}
