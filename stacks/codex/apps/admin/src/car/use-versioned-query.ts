import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type DataVersionSnapshot, useDataVersionSignal } from './stream.ts';

interface Versioned {
  readonly dataVersion: number;
}

export function useVersionedQuery<T extends Versioned>(
  query: UseQueryResult<T, Error>,
): { result: UseQueryResult<T, Error>; signal: DataVersionSnapshot } {
  const signal = useDataVersionSignal();
  const renderedVersion = query.data?.dataVersion;
  const isFetching = query.isFetching;

  useEffect(() => {
    if (query.isError || renderedVersion === undefined) return;
    if (signal.version === null || signal.version === renderedVersion) return;
    if (isFetching) return;
    void query.refetch();
  }, [signal.version, renderedVersion, isFetching, query.isError, query.refetch]);

  return { result: query, signal };
}
