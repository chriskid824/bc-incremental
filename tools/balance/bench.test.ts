import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/data';
import { createSimulation, DRONE_KIND_DRONE, DRONE_KIND_TURRET, NO_INPUT } from '../../src/sim';
import { SUMMON_CAP } from '../../src/sim/caps';
import { HIVE_DRONES, HIVE_TURRETS, hiveListened, SCENARIOS, summonWorkload } from './bench';

const hive = SCENARIOS.hive;
const data = loadGameData();

describe('the hive bench scenario', () => {
  it('is normal’s 3-minute run with the swarm as the signature, and not of the stress family', () => {
    const { normal } = SCENARIOS;
    expect([hive.runs, hive.warmup, hive.seconds, hive.targetMs]).toEqual([
      normal.runs,
      normal.warmup,
      normal.seconds,
      normal.targetMs,
    ]);
    expect(hive.config(3, 30, '')).toEqual({
      ...normal.config(3, 30, ''),
      signature: { id: 'swarm' },
    });
    expect([hive.data, hive.startWave, hive.stress, hive.summons]).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
  });

  it('has 24 slots: 20 drones and 4 turrets, the summon cap, none refused', () => {
    expect([HIVE_DRONES, HIVE_TURRETS]).toEqual([20, 4]);
    expect(HIVE_DRONES + HIVE_TURRETS).toBe(SUMMON_CAP);
    const sim = createSimulation(
      { ...hive.config(1, 30, ''), maxTicks: 1 },
      data,
      hive.testModules,
    );
    const { drones, droneCount } = sim.state;
    const kinds = Array.from(drones.kind.subarray(0, droneCount));
    expect(kinds.filter((kind) => kind === DRONE_KIND_DRONE)).toHaveLength(20);
    expect(kinds.filter((kind) => kind === DRONE_KIND_TURRET)).toHaveLength(4);
    expect(droneCount).toBe(24);
    sim.step(NO_INPUT);
    expect(sim.result().counters.summonCapped).toBe(0);
  });

  it('listens to droneImpact: its listener counts every impact, and its turrets fire', () => {
    const before = hiveListened.impacts;
    const workload = summonWorkload(
      { ...hive.config(1, 30, ''), maxTicks: 600 },
      data,
      hive.testModules,
    );
    expect([workload.drones, workload.turrets]).toEqual([20, 4]);
    expect(workload.impacts).toBeGreaterThan(0);
    // No repeats: every impact is the signature's own, which raises droneImpact (rule 8).
    expect(workload.listened).toBe(workload.impacts);
    expect(hiveListened.impacts - before).toBe(workload.impacts);
    expect(workload.firings).toBeGreaterThan(0);
    expect(workload.turretShots).toBeGreaterThanOrEqual(workload.firings);
    expect(workload.kills).toBeGreaterThan(0);
  });
});
