export class ResourceRequestFence {
  private generation = 0;

  begin() {
    return ++this.generation;
  }

  invalidate() {
    this.generation++;
  }

  isCurrent(generation: number) {
    return generation === this.generation;
  }
}
