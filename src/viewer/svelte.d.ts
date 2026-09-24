// Lets plain tsc import .svelte files; svelte-check type-checks the components themselves.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<any>;
  export default component;
}
