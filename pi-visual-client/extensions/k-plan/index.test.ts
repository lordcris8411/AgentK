import assert from "node:assert/strict";
import test from "node:test";
import { repairPlanMarkdown, validatePlanMarkdown } from "./index.ts";

test("accepts the strict K's Plan format", () => {
  const result = validatePlanMarkdown(`# Plan: Build feature

## Goal
Deliver the feature safely.

## Steps
1. Inspect the existing implementation.
2. Implement and test the change.

## Notes
Preserve backwards compatibility.
`);
  assert.equal(result.valid, true);
  assert.deepEqual(result.steps.map((step) => step.step), [1, 2]);
});

test("repairs localized headings, heading-style steps, and numbering", () => {
  const repaired = repairPlanMarkdown(`# 计划：构建功能

## 目标
安全交付功能。

## 实施步骤
### 2、检查现有实现
### 4．实现并测试修改

## 注意事项
保持向后兼容。
`);
  const result = validatePlanMarkdown(repaired);
  assert.equal(result.valid, true);
  assert.equal(result.title, "构建功能");
  assert.deepEqual(result.steps, [
    { step: 1, text: "检查现有实现" },
    { step: 2, text: "实现并测试修改" },
  ]);
});

test("rejects missing sections and non-sequential steps", () => {
  const result = validatePlanMarkdown(`# Plan: Invalid

## Goal
Something.

## Steps
2. Starts at two.
`);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /Notes|sequential|sections/);
});
