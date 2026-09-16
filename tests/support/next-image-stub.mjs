import { createElement } from "react";

export default function Image({ fill: _fill, unoptimized: _unoptimized, ...props }) {
  return createElement("img", props);
}
