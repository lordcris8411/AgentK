#include <iostream>

struct Operation {
  virtual ~Operation() = default;
  virtual int apply(int left, int right) const = 0;
};

struct Addition final : Operation {
  int apply(int left, int right) const override { return left + right; }
};

int add(int left, int right) { return left + right; }

int calculate(const Operation& operation, int left, int right) {
  return operation.apply(left, right);
}

int main() {
  Addition addition;
  std::cout << add(20, 22) << '\n';
  std::cout << calculate(addition, 10, 32) << '\n';
  return 0;
}
