/**
 * `autopilot resume` is temporarily unavailable while Camouflage UI access is
 * disabled. This module is kept so imports do not break, but it exits
 * immediately with an explanatory message.
 */

export interface CamouflageResumeOpts {
  limit?: number;
  camouflageBin?: string;
}

export async function runCamouflageResume(_opts: CamouflageResumeOpts = {}): Promise<void> {
  process.stderr.write("autopilot resume: temporarily unavailable. Camouflage UI access is disabled.\n");
  process.exitCode = 2;
}
