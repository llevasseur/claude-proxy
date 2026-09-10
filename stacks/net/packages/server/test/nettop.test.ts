import { describe, expect, it } from 'vitest';
import { FLOW_PID, parseBootTime, parseCsvLine, parseNettopCsv } from '../src/nettop.ts';

describe('parseCsvLine', () => {
  it('splits plain fields', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quoted fields and un-doubles quotes', () => {
    expect(parseCsvLine('"Claude Helper (Renderer)",en0,"1,024"')).toEqual([
      'Claude Helper (Renderer)',
      'en0',
      '1,024',
    ]);
    expect(parseCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
  });
});

describe('parseBootTime', () => {
  it('reads the sec field from sysctl output', () => {
    expect(parseBootTime('{ sec = 1756147200, usec = 123456 } Tue Sep  1 00:00:00 2026')).toBe(1_756_147_200);
  });

  it('returns null for output without a sec field', () => {
    expect(parseBootTime('garbage')).toBeNull();
    expect(parseBootTime('')).toBeNull();
  });
});

describe('parseNettopCsv', () => {
  const HEADER =
    'time,,interface,state,bytes_in,bytes_out,rx_dupe,rx_ooo,re-tx,rtt_avg,rcvsize,tx_win,tc_class,tc_mgt,cc_algo,P,C,R,W,arch,';

  it('parses process rows with interfaces and keeps counters cumulative', () => {
    const csv = [
      HEADER,
      '13:55:39.949035,launchd.1,en0,,1000,2000,0,0,0,,,,,,,,,,,,',
      '13:55:39.949071,syslogd.360,en5,,5,10,0,0,0,,,,,,,,,,,,',
    ].join('\n');
    expect(parseNettopCsv(csv)).toEqual([
      { name: 'launchd', pid: 1, interface: 'en0', bytesIn: 1000, bytesOut: 2000 },
      { name: 'syslogd', pid: 360, interface: 'en5', bytesIn: 5, bytesOut: 10 },
    ]);
  });

  it('drops loopback rows', () => {
    const csv = [HEADER, '13:55:39.947193,udp4 *:60959<->*.*,lo0,,0,1029,,,,,,,,,,,,,so,'].join('\n');
    expect(parseNettopCsv(csv)).toEqual([]);
  });

  it('stores socket-flow rows under their tuple with the synthetic flow pid', () => {
    const csv = [
      HEADER,
      '13:55:39.947382,tcp4 *:5900<->*:*,en0,Listen,,,,,,,,-,cubic,-,-,-,-,so,',
      '14:14:15.097381,tcp4 172.19.207.31:54337<->17.57.147.5:443,en0,Established,16992,33353,0,0,1448',
    ].join('\n');
    expect(parseNettopCsv(csv)).toEqual([
      { name: 'tcp4 *:5900<->*:*', pid: FLOW_PID, interface: 'en0', bytesIn: 0, bytesOut: 0 },
      {
        name: 'tcp4 172.19.207.31:54337<->17.57.147.5:443',
        pid: FLOW_PID,
        interface: 'en0',
        bytesIn: 16992,
        bytesOut: 33353,
      },
    ]);
  });

  it('parses process rows that do carry an interface (the shape this plan assumed)', () => {
    const csv = [HEADER, '13:55:39.949035,node.100,en0,,1000,2000,0,0,0,,,,,,,,,,,,'].join('\n');
    expect(parseNettopCsv(csv)).toEqual([{ name: 'node', pid: 100, interface: 'en0', bytesIn: 1000, bytesOut: 2000 }]);
  });

  it('drops per-process aggregate rows with a missing interface', () => {
    const csv = ['13:55:39.949035,launchd.1,,,0,0,0,0,0'].join('\n');
    expect(parseNettopCsv(`time,,interface,state,bytes_in,bytes_out\n${csv}`)).toEqual([]);
  });

  it('parses quoted process names containing spaces and punctuation', () => {
    const csv = [HEADER, '13:56:01.000000,"Claude Helper (Renderer).901",en0,,7,9,0,0,0,,,,,,,,,,,,'].join('\n');
    expect(parseNettopCsv(csv)).toEqual([
      { name: 'Claude Helper (Renderer)', pid: 901, interface: 'en0', bytesIn: 7, bytesOut: 9 },
    ]);
  });

  it('returns null when the payload has no recognizable header', () => {
    expect(parseNettopCsv('not,csv,at,all\n1,2,3')).toBeNull();
    expect(parseNettopCsv('')).toBeNull();
  });

  it('drops rows whose byte counts are not integers', () => {
    const csv = [HEADER, '13:55:39.949035,launchd.1,en0,,many,0,0,0,0'].join('\n');
    expect(parseNettopCsv(csv)).toEqual([]);
  });
});
