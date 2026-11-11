import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../api';

export const competitorKey = ['competitors'] as const;
export const timelineKey = (id: string) => ['snapshots', id] as const;

export function useCompetitors() {
  return useQuery({
    queryKey: competitorKey,
    queryFn: ({ signal }) => api.competitors(signal),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useTimeline(id: string) {
  return useInfiniteQuery({
    queryKey: timelineKey(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.snapshots(id, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    // Infinite-query refetches walk every loaded page. Once older history is
    // open, refresh only on explicit request, including after focus/reconnect.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) <= 1 ? 10_000 : false),
    refetchOnWindowFocus: (query) => (query.state.data?.pages.length ?? 0) <= 1,
    refetchOnReconnect: (query) => (query.state.data?.pages.length ?? 0) <= 1,
    refetchOnMount: (query) => (query.state.data?.pages.length ?? 0) <= 1,
    staleTime: 5_000,
  });
}
