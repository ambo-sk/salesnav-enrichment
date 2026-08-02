import { getGaussianDelayMs } from './timing';

/**
 * Simulate a human-like click with full mouse event sequence.
 * Dispatches: mouseover -> mousedown -> mouseup -> click
 * with realistic inter-event delays.
 */
export async function simulateHumanClick(element: Element): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const commonProps = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  };

  element.dispatchEvent(new MouseEvent('mouseover', commonProps));
  await new Promise(r => setTimeout(r, getGaussianDelayMs(50, 150)));

  element.dispatchEvent(new MouseEvent('mousedown', commonProps));
  await new Promise(r => setTimeout(r, getGaussianDelayMs(30, 80)));

  element.dispatchEvent(new MouseEvent('mouseup', commonProps));
  await new Promise(r => setTimeout(r, getGaussianDelayMs(10, 30)));

  element.dispatchEvent(new MouseEvent('click', commonProps));
}
