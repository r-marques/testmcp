import { add, divide, fibonacci } from '../src/math';

describe('add', () => {
  it('should add two positive numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('should handle negative numbers', () => {
    expect(add(-1, -2)).toBe(-3);
  });

  it('should handle zero', () => {
    expect(add(0, 0)).toBe(0);
  });
});

describe('divide', () => {
  it('should divide two numbers', () => {
    expect(divide(10, 2)).toBe(5);
  });

  it('should fail on intentional wrong expectation', () => {
    // Intentional failure: divide(10, 3) is 3.333..., not 3
    expect(divide(10, 3)).toBe(3);
  });
});

describe('fibonacci', () => {
  it('should return 0 for n=0', () => {
    expect(fibonacci(0)).toBe(0);
  });

  it('should return 1 for n=1', () => {
    expect(fibonacci(1)).toBe(1);
  });

  it('should return 55 for n=10', () => {
    expect(fibonacci(10)).toBe(55);
  });

  it('should fail with wrong expectation for n=6', () => {
    // Intentional failure: fibonacci(6) is 8, not 13
    expect(fibonacci(6)).toBe(13);
  });
});
