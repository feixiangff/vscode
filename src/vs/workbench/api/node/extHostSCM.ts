/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import Event, { Emitter } from 'vs/base/common/event';
import { asWinJsPromise } from 'vs/base/common/async';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { ExtHostCommands, CommandsConverter } from 'vs/workbench/api/node/extHostCommands';
import { MainContext, MainThreadSCMShape, SCMRawResource } from './extHost.protocol';
import * as vscode from 'vscode';

function getIconPath(decorations: vscode.SourceControlResourceThemableDecorations) {
	if (!decorations) {
		return undefined;
	} else if (typeof decorations.iconPath === 'string') {
		return URI.file(decorations.iconPath).toString();
	} else if (decorations.iconPath) {
		return `${decorations.iconPath}`;
	}
	return undefined;
}

export class ExtHostSCMInputBox {

	private _value: string = '';

	get value(): string {
		return this._value;
	}

	set value(value: string) {
		this._proxy.$setInputBoxValue(value);
		this.updateValue(value);
	}

	private _onDidChange = new Emitter<string>();

	get onDidChange(): Event<string> {
		return this._onDidChange.event;
	}

	private _onDidAccept = new Emitter<string>();

	get onDidAccept(): Event<string> {
		return this._onDidAccept.event;
	}

	constructor(private _proxy: MainThreadSCMShape) {
		// noop
	}

	$onInputBoxValueChange(value: string): void {
		this.updateValue(value);
	}

	$onInputBoxAcceptChanges(): void {
		this._onDidAccept.fire(this._value);
	}

	private updateValue(value: string): void {
		this._value = value;
		this._onDidChange.fire(value);
	}
}

class ExtHostSourceControlResourceGroup implements vscode.SourceControlResourceGroup {

	private static _handlePool: number = 0;
	private _resourceHandlePool: number = 0;
	private _resourceStates: Map<ResourceStateHandle, vscode.SourceControlResourceState> = new Map<ResourceStateHandle, vscode.SourceControlResourceState>();

	get id(): string {
		return this._id;
	}

	get label(): string {
		return this._label;
	}

	private _hideWhenEmpty: boolean | undefined = undefined;

	get hideWhenEmpty(): boolean | undefined {
		return this._hideWhenEmpty;
	}

	set hideWhenEmpty(hideWhenEmpty: boolean | undefined) {
		this._hideWhenEmpty = hideWhenEmpty;
		this._proxy.$updateGroup(this._sourceControlHandle, this._handle, { hideWhenEmpty });
	}

	set resourceStates(resources: vscode.SourceControlResourceState[]) {
		this._resourceStates.clear();

		const rawResources = resources.map(r => {
			const handle = this._resourceHandlePool++;
			this._resourceStates.set(handle, r);

			const sourceUri = r.resourceUri.toString();
			const command = this._commands.toInternal(r.command);
			const iconPath = getIconPath(r.decorations);
			const lightIconPath = r.decorations && getIconPath(r.decorations.light) || iconPath;
			const darkIconPath = r.decorations && getIconPath(r.decorations.dark) || iconPath;
			const icons: string[] = [];

			if (lightIconPath || darkIconPath) {
				icons.push(lightIconPath);
			}

			if (darkIconPath !== lightIconPath) {
				icons.push(darkIconPath);
			}

			const strikeThrough = r.decorations && !!r.decorations.strikeThrough;

			return [handle, sourceUri, command, icons, strikeThrough] as SCMRawResource;
		});

		this._proxy.$updateGroupResourceStates(this._sourceControlHandle, this._handle, rawResources);
	}

	private _handle: GroupHandle = ExtHostSourceControlResourceGroup._handlePool++;
	get handle(): GroupHandle {
		return this._handle;
	}

	constructor(
		private _proxy: MainThreadSCMShape,
		private _commands: CommandsConverter,
		private _sourceControlHandle: number,
		private _id: string,
		private _label: string,
	) {
		this._proxy.$registerGroup(_sourceControlHandle, this._handle, _id, _label);
	}

	getResourceState(handle: number): vscode.SourceControlResourceState | undefined {
		return this._resourceStates.get(handle);
	}

	dispose(): void {
		this._proxy.$unregisterGroup(this._sourceControlHandle, this._handle);
	}
}

class ExtHostSourceControl implements vscode.SourceControl {

	private static _handlePool: number = 0;
	private _groups: Map<GroupHandle, ExtHostSourceControlResourceGroup> = new Map<GroupHandle, ExtHostSourceControlResourceGroup>();

	get id(): string {
		return this._id;
	}

	get label(): string {
		return this._label;
	}

	private _count: number | undefined = undefined;

	get count(): number | undefined {
		return this._count;
	}

	set count(count: number | undefined) {
		this._count = count;
		this._proxy.$updateSourceControl(this._handle, { count });
	}

	private _quickDiffProvider: vscode.QuickDiffProvider | undefined = undefined;

	get quickDiffProvider(): vscode.QuickDiffProvider | undefined {
		return this._quickDiffProvider;
	}

	set quickDiffProvider(quickDiffProvider: vscode.QuickDiffProvider | undefined) {
		this._quickDiffProvider = quickDiffProvider;
		this._proxy.$updateSourceControl(this._handle, { hasQuickDiffProvider: !!quickDiffProvider });
	}

	private _handle: number = ExtHostSourceControl._handlePool++;

	constructor(
		private _proxy: MainThreadSCMShape,
		private _commands: CommandsConverter,
		private _id: string,
		private _label: string,
	) {
		this._proxy.$registerSourceControl(this._handle, _id, _label);
	}

	createResourceGroup(id: string, label: string): ExtHostSourceControlResourceGroup {
		const group = new ExtHostSourceControlResourceGroup(this._proxy, this._commands, this._handle, id, label);
		this._groups.set(group.handle, group);
		return group;
	}

	getResourceState(groupHandle: GroupHandle, handle: number): vscode.SourceControlResourceState | undefined {
		const group = this._groups.get(groupHandle);

		if (!group) {
			return undefined;
		}

		return group.getResourceState(handle);
	}

	dispose(): void {
		this._proxy.$unregisterSourceControl(this._handle);
	}
}

type ProviderHandle = number;
type GroupHandle = number;
type ResourceStateHandle = number;

export class ExtHostSCM {

	private static _handlePool: number = 0;

	private _proxy: MainThreadSCMShape;
	private _sourceControls: Map<ProviderHandle, ExtHostSourceControl> = new Map<ProviderHandle, ExtHostSourceControl>();

	private _onDidChangeActiveProvider = new Emitter<vscode.SourceControl>();
	get onDidChangeActiveProvider(): Event<vscode.SourceControl> { return this._onDidChangeActiveProvider.event; }

	private _activeProvider: vscode.SourceControl | undefined;
	get activeProvider(): vscode.SourceControl | undefined { return this._activeProvider; }

	private _inputBox: ExtHostSCMInputBox;
	get inputBox(): ExtHostSCMInputBox { return this._inputBox; }

	constructor(
		threadService: IThreadService,
		private _commands: ExtHostCommands
	) {
		this._proxy = threadService.get(MainContext.MainThreadSCM);
		this._inputBox = new ExtHostSCMInputBox(this._proxy);

		_commands.registerArgumentProcessor({
			processArgument: arg => {
				if (arg && arg.$mid === 3) {
					const sourceControl = this._sourceControls.get(arg.sourceControlHandle);

					if (!sourceControl) {
						return arg;
					}

					return sourceControl.getResourceState(arg.groupHandle, arg.handle);
				}

				return arg;
			}
		});
	}

	createSourceControl(id: string, label: string): vscode.SourceControl {
		const handle = ExtHostSCM._handlePool++;
		const sourceControl = new ExtHostSourceControl(this._proxy, this._commands.converter, id, label);
		this._sourceControls.set(handle, sourceControl);

		return sourceControl;
	}

	$provideOriginalResource(sourceControlHandle: number, uri: URI): TPromise<URI> {
		const sourceControl = this._sourceControls.get(sourceControlHandle);

		if (!sourceControl || !sourceControl.quickDiffProvider) {
			return TPromise.as(null);
		}

		return asWinJsPromise(token => sourceControl.quickDiffProvider.provideOriginalResource(uri, token));
	}

	$onActiveSourceControlChange(handle: number): TPromise<void> {
		this._activeProvider = this._sourceControls.get(handle);
		return TPromise.as(null);
	}

	$onInputBoxValueChange(value: string): TPromise<void> {
		this._inputBox.$onInputBoxValueChange(value);
		return TPromise.as(null);
	}

	$onInputBoxAcceptChanges(): TPromise<void> {
		this._inputBox.$onInputBoxAcceptChanges();
		return TPromise.as(null);
	}
}
