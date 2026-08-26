import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// React error boundaries have no hook equivalent — they must be a class
// component. This exists specifically for asset loading: useGLTF throws
// past Suspense (which only handles pending promises, not failures) when a
// model request genuinely fails rather than just being slow — a real
// possibility on an unstable connection (a dropped connection, a timeout,
// a reset), not just a hypothetical. Without this catching it, that error
// propagates all the way up and unmounts the entire app to a blank white
// screen with zero feedback and no way to recover short of a manual
// browser refresh the player has no reason to know to try.
export class SceneErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Scene failed to load:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-950 text-center px-6"
          // Higher than drei's Loader (zIndex: 1000, see App.tsx) — if the
          // failure happens mid-load, this must win, not sit hidden behind
          // a loading bar that's still showing for whatever else was
          // in flight.
          style={{ zIndex: 2000 }}
        >
          <p className="text-neutral-500 text-[10px] uppercase tracking-[0.2em] mb-2">Load Failed</p>
          <p className="font-black text-2xl tracking-wider uppercase mb-3 text-red-500">
            Couldn&apos;t Load The Game
          </p>
          <p className="text-neutral-400 text-xs mb-6 max-w-sm">
            Something didn&apos;t load correctly — this can happen on an unstable connection. Reload to try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 px-8 rounded-xl shadow-lg transition-colors"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
