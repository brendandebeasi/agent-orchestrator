import { QueryClient } from "@tanstack/react-query";
import { subscribeServerTarget } from "./server-target";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 10_000,
			refetchOnWindowFocus: false,
		},
	},
});

// Every cached entry describes one daemon. Ids, paths, and PR state are not
// comparable across machines, so a target change makes the whole cache wrong
// rather than stale — invalidating would keep the old server's answers on
// screen until the new one replied, which is exactly the frame where the two
// are most easily confused. Drop it instead; active queries refetch against
// whatever the new target turns out to be.
subscribeServerTarget(() => {
	queryClient.clear();
});
