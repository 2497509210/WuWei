// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstallGuide } from "../../frontend/src/components/InstallGuide";

afterEach(()=>{cleanup();vi.unstubAllGlobals();});

// Platforms without a deferred install event still need a usable way to add a shortcut.
it("offers menu instructions when browser installation is unavailable",()=>{
  render(createElement(InstallGuide));
  fireEvent.click(screen.getByRole("button",{name:"添加到手机桌面"}));
  expect(screen.getByRole("dialog",{name:"添加到手机桌面"})).toBeTruthy();
  expect(screen.getByText(/添加到主屏幕/)).toBeTruthy();
});

// A deferred install request must only run after the user's click, and cancellation must remain retryable.
it("waits for an explicit click before browser installation and handles dismissal",async()=>{
  render(createElement(InstallGuide));
  let triggered=false;
  const event=new Event("beforeinstallprompt",{cancelable:true});
  Object.assign(event,{prompt:async()=>{triggered=true;},userChoice:Promise.resolve({outcome:"dismissed"})});
  await act(async()=>{window.dispatchEvent(event);});
  expect(triggered).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"添加到手机桌面"}));
  await screen.findByText("本次未添加，可以稍后再试。");
  expect(triggered).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"添加到手机桌面"}));
  expect(screen.getByRole("dialog",{name:"添加到手机桌面"})).toBeTruthy();
});

// Already installed standalone mode should not keep prompting users to install again.
it("hides installation guidance in standalone mode",()=>{
  vi.stubGlobal("matchMedia",()=>({matches:true,addEventListener(){},removeEventListener(){}}));
  render(createElement(InstallGuide));
  expect(screen.queryByRole("button",{name:"添加到手机桌面"})).toBeNull();
});
