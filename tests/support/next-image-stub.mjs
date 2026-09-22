import { createElement } from "react";

export default function Image({ fill: _fill, unoptimized: _unoptimized, ...props }) {
  void _fill;
  void _unoptimized;
  return createElement("img", props);
}
