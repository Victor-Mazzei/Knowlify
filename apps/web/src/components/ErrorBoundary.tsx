import { Component } from "react";
import type { ReactNode } from "react";
import { Logo } from "./Logo";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="login-shell">
        <section className="login-card" role="alert">
          <div className="brand">
            <Logo size={32} />
            Knowlify
          </div>
          <h1>Something went wrong</h1>
          <p className="login-copy">{this.state.error.message}</p>
          <button className="primary" onClick={() => window.location.assign("/")}>
            Back to library
          </button>
        </section>
      </main>
    );
  }
}
