import {
	isNode,
	getNodeLength,
	isTextNode,
	closest,
	isInlineElement,
	splitTextNode,
	getSibling,
	getParentSibling,
	unwrap,
	getMaxDeepNode, createElement, cloneNode, createDOMMatcher, IDOMMatcher, removeNode
} from './dom';

import {
	createRange,
	getNodeFromRange,
	RangePoint,
	setRangeStart,
	setRangeEnd,
	surroundContents,
} from './selection';

function _insertNode(wrapper: Node, node: Node, type: 'next' | 'prev') {
	if (type === 'next') {
		wrapper.appendChild(node);
	} else {
		wrapper.insertBefore(node, wrapper.firstChild);
	}
}

function _cleanup(el: HTMLElement, matcher: IDOMMatcher): [Node, Node] {
	if (matcher.attributesMatcher.length) {
		if (matcher.styleMatcher.length) {
			matcher.styleMatcher.keys.forEach(name => {
				el.style.removeProperty(name);
			});

			!el.style.length && el.removeAttribute('style');

			if ((isNode(el, 'span') || isNode(el, matcher.tagName)) && !el.attributes.length) {
				return unwrap(el);
			}
		}

		return [el, el];
	} else {
		return unwrap(el);
	}
}

function _deepUnwrap(container: HTMLElement, matcher: IDOMMatcher): [Node, Node] {
	const elements = container.getElementsByTagName(matcher.tagName);
	let idx = elements.length;
	let result: [Node, Node];

	while (idx--) {
		const el = <HTMLElement>elements[idx];

		if (matcher.test(el)) {
			result = _cleanup(el, matcher) || result;
		}
	}

	if (matcher.test(container)) {
		result = _cleanup(container, matcher) || result;
	}

	return result || [container, container];
}


function _toNormalizedRange(range: Range): [Node, number, Node, number] {
	let {
		startContainer: start,
		startOffset,
		endContainer: end,
		endOffset,
	} = range;

	if (!isTextNode(start)) {
		[start, startOffset] = getMaxDeepNode(start, startOffset, 'start');
	}

	if (!isTextNode(end)) {
		[end, endOffset] = getMaxDeepNode(end, Math.max(endOffset -1, 0), 'end');
	}

	return [start, startOffset, end, endOffset];
}


export function removeStyle(range: Range, tagName: string, attributes?: any): void {
	if (range.collapsed) {
		return;
	}

	const matcher = createDOMMatcher(tagName, attributes, true);

	let [start, startOffset, end, endOffset] = _toNormalizedRange(range);
	let startWrappedParent = closest(start, matcher);
	let endWrapperParent = closest(end, matcher);

	console.log('removeStyle', [start, startOffset, end, endOffset]);

	[start, end, startOffset, endOffset] = removeStyleBetween(matcher, startWrappedParent, endWrapperParent, start, startOffset, end, endOffset);

	let cursor = start;

	while (cursor !== end && cursor != null) {
		!isTextNode(cursor) && _deepUnwrap(<HTMLElement>cursor, matcher);
		cursor = cursor.contains(end) && cursor.firstChild || cursor.nextSibling || getParentSibling(cursor, 'next');
	}

	console.log('removeStyle.set', [start, startOffset, end, endOffset]);
	range.setStart(start, startOffset);
	range.setEnd(end, endOffset);
}

function applyMatcherStyle(element: HTMLElement, matcher: IDOMMatcher): HTMLElement {
	matcher.styleMatcher.keys.forEach(name => {
		element.style.setProperty(name, matcher.styleMatcher.attributes[name]);
	});

	return element;
}

function removeMatcherStyle(element: HTMLElement, matcher: IDOMMatcher): HTMLElement {
	matcher.styleMatcher.keys.forEach(name => {
		element.style.removeProperty(name);
	});

	return element;
}

function _getCSSPropsList(target: HTMLElement): Array<keyof CSSStyleDeclaration> {
	const R_PROP_NAME = /\b([a-z-]+):/g;
	const cssText = target.style.cssText;
	const list = [];
	let match;

	while (match = R_PROP_NAME.exec(cssText)) {
		list.push(match[1]);
	}

	return <any>list;
}

function resizeWrapper(
	matcher: IDOMMatcher,
	startWrappedParent: HTMLElement,
	start: Node,
	startOffset: number,
	end: Node,
	endOffset: number,
	vector: 'next' | 'prev'
): [HTMLElement, Node, number] {
	const actualStylePropsLength = _getCSSPropsList(<HTMLElement>startWrappedParent).length;
	const isNext = vector === 'next';

	// Мы в начале врапера и стили совпадают, просто меняем стили
	if (
		(isNext ? !startOffset : startOffset === getNodeLength(start)) &&
		(getMaxDeepNode(startWrappedParent, isNext ? 0 : 'max', 'start')[0] === start)
	) {
		// Меняем стили
		applyMatcherStyle(startWrappedParent, matcher);

		// Количество стилей не совпадает, меняем стиль враперу и двигаемся дальше
		if (!isNode(startWrappedParent, 'span') || matcher.styleMatcher.keys.length !== actualStylePropsLength) {
			start = getSibling(startWrappedParent, vector);
			startOffset = isNext ? 0 : getNodeLength(start);
			startWrappedParent = null;
		}
	} else {
		let stopFrag;
		let startFrag;
		let endFrag;

		if (isTextNode(start)) {
			if (isNext) {
				[stopFrag, start] = splitTextNode(start, startOffset);
				startOffset = 0;
			} else {
				[start, stopFrag] = splitTextNode(start, startOffset);
				startOffset = getNodeLength(start);
			}
		} else {
			stopFrag = getSibling(start, isNext ? 'prev' : 'next');
		}

		// Только после сплита
		if (isNext) {
			[startFrag, endFrag] = unwrap(startWrappedParent, null, false);
			startWrappedParent.parentNode.insertBefore(startWrappedParent, startFrag);
		} else {
			[endFrag, startFrag] = unwrap(startWrappedParent, null, false);
		}

		_applyStyle(
			matcher,
			startWrappedParent,
			startWrappedParent,
			startFrag,
			0,
			stopFrag,
			isNext ? getNodeLength(stopFrag) : 0,
			vector
		);

		if (end !== endFrag && (!isNode(startWrappedParent, 'span') || actualStylePropsLength !== matcher.styleMatcher.length)) {
			startWrappedParent = cloneNode<HTMLElement>(startWrappedParent);

			applyMatcherStyle(startWrappedParent, matcher);

			_applyStyle(
				matcher,
				null,
				startWrappedParent,
				start,
				0,
				endFrag,
				getNodeLength(endFrag),
				vector
			);

			start = endFrag;
			startOffset = isNext ? getNodeLength(endFrag) : 0;
		}

		startWrappedParent = null;
	}

	return [startWrappedParent, start, startOffset];
}

function _getDiffCSSProps(target: HTMLElement, matcher: IDOMMatcher): string[] {
	return _getCSSPropsList(target).filter(name => !matcher.styleMatcher.attributes.hasOwnProperty(name));
}

function removeStyleBetween(
	matcher: IDOMMatcher,
	startWrappedParent: HTMLElement,
	endWrapperParent: HTMLElement,
	start: Node,
	startOffset: number,
	end: Node,
	endOffset: number,
	force?: boolean
): [Node, Node, number, number] {
	let isSolidWrapper = startWrappedParent === endWrapperParent;
	let startIsFirst = false;
	let endIsLast = false;
	let wrapStart;
	let wrapEnd;
	let isClone = false;

	if (!startOffset && startWrappedParent) {
		startIsFirst = getMaxDeepNode(startWrappedParent, 0, 'start')[0] === start;
	}

	if (endOffset && endWrapperParent && endOffset === getNodeLength(end)) {
		endIsLast = getMaxDeepNode(endWrapperParent, 'max', 'end')[0] === end;
	}

	if (!endIsLast && endWrapperParent) {
		[wrapStart, wrapEnd] = unwrap(endWrapperParent, null, false);

		if (isSolidWrapper) {
			isClone = true;
			startWrappedParent = cloneNode<HTMLElement>(endWrapperParent);
			wrapStart.parentNode.insertBefore(startWrappedParent, wrapStart);
		}

		if (wrapStart === end && isTextNode(end)) {
			[wrapStart, end] = splitTextNode(<Text>end, endOffset);
			endOffset = 0;
		}

		_applyStyle(
			matcher,
			endWrapperParent,
			endWrapperParent,
			end,
			endOffset,
			wrapEnd,
			getNodeLength(wrapEnd),
			'prev'
		);

		if (!force && !isSolidWrapper && (
			!isNode(endWrapperParent, 'span')  && !isNode(startWrappedParent, matcher.tagName)
			|| _getDiffCSSProps(endWrapperParent, matcher).length)
		) {
			_applyStyle(
				matcher,
				null,
				removeMatcherStyle(cloneNode<HTMLElement>(endWrapperParent), matcher),
				wrapStart,
				0,
				end,
				endOffset,
				'prev'
			);
		}

		end = getSibling(endWrapperParent, 'prev');
		endOffset = null; // нужно перерасчитать, но только в конце, потому что ещё начало не убрали

		if (isSolidWrapper) {
			start = getSibling(startWrappedParent);
			wrapStart = start;
		}
	}

	if (startWrappedParent) {
		if (!startIsFirst) {
			if (!isSolidWrapper || endIsLast) {
				[wrapStart, wrapEnd] = unwrap(startWrappedParent);
				wrapStart.parentNode.insertBefore(startWrappedParent, wrapStart);
			}

			if (wrapStart === start && isTextNode(start)) {
				[wrapStart, start] = splitTextNode(<Text>start, startOffset);
				startOffset = 0;

				if (start === end) {
					endOffset = null;
				}
			}

			_applyStyle(
				matcher,
				startWrappedParent,
				startWrappedParent,
				wrapStart,
				0,
				start,
				startOffset,
				'next'
			);

			if (!force && (
				!isNode(startWrappedParent, 'span') && !isNode(startWrappedParent, matcher.tagName) ||
				_getDiffCSSProps(startWrappedParent, matcher).length
			)) {
				_applyStyle(
					matcher,
					null,
					removeMatcherStyle(cloneNode<HTMLElement>(startWrappedParent), matcher),
					start,
					0,
					isSolidWrapper ? end : wrapEnd,
					getNodeLength(isSolidWrapper ? end : wrapEnd),
					'next'
				);
			}

			startOffset = 0;
		} else {
			if (matcher.styleMatcher.length && !isClone) {
				_cleanup(startWrappedParent, matcher);
			} else {
				unwrap(startWrappedParent);
			}
		}
	}

	return [start, end, startOffset, endOffset === null ? getNodeLength(end) : endOffset];
}

function _equalStyle(left: HTMLElement, right: HTMLElement): boolean {
	const leftProps = _getCSSPropsList(left);
	const rightProps = _getCSSPropsList(right);

	return leftProps.length === rightProps.length && leftProps.every(name => rightProps.indexOf(name) !== -1);
}

export function applyStyle(range: Range, tagName: string, attributes?: {[index: string]: any}): void {
	if (range.collapsed) {
		return;
	}

	const matcher = createDOMMatcher(tagName, attributes, true);

	let wrapperElement = createElement(tagName === '*' ? 'span' : tagName, attributes);
	let [start, startOffset, end, endOffset] = _toNormalizedRange(range);
	let startWrappedParent = closest(start, matcher);
	let endWrapperParent = closest(end, matcher);
	let isSolidWrapper = startWrappedParent && startWrappedParent === endWrapperParent;
	let endFrag; // используется при объединении враперов
	let endFragOffset;
	let endSelected = endOffset && endOffset === getNodeLength(end);

	if (matcher.styleMatcher.length) {
		// Вот это важный момент, нужно проверить на строгое соотвествие
		if (startWrappedParent && endWrapperParent) {
			// todo: сделать метод, который будет это проверять?
			let startIsFirst = !startOffset && (getMaxDeepNode(startWrappedParent, 0, 'start')[0] === start);
			let endIsLast = endOffset && (endOffset === getNodeLength(end)) && (getMaxDeepNode(endWrapperParent, 'max', 'end')[0] === end);

			if (isSolidWrapper && startIsFirst && endIsLast) {
				// Выделен весь тег, можно смело менять ему стили
				applyMatcherStyle(startWrappedParent, matcher);
				return;
			} else if (
				endIsLast &&
				!isSolidWrapper &&
				isNode(startWrappedParent, endWrapperParent.nodeName) &&
				_equalStyle(startWrappedParent, endWrapperParent)
			) {
				// Выделение находится в конце тега
				endFrag = unwrap(endWrapperParent)[1];
				endFragOffset = getNodeLength(endFrag);
				endWrapperParent = null;
			} else if (isSolidWrapper) {
				// Выделение внутри тега, нужно его разрезать
				[start, end, startOffset, endOffset] = removeStyleBetween(matcher, startWrappedParent, endWrapperParent, start, startOffset, end, endOffset, true);

				wrapperElement = applyMatcherStyle(cloneNode<HTMLElement>(startWrappedParent), matcher);
				startWrappedParent = null;
				endWrapperParent = null;
			}
		}

		if (endWrapperParent) {
			[endWrapperParent, end, endOffset] = resizeWrapper(
				matcher,
				endWrapperParent,
				end,
				endOffset,
				start,
				startOffset,
				'prev'
			);
			endSelected = endOffset === getNodeLength(end);
		}

		if (startWrappedParent) {
			[startWrappedParent, start, startOffset] = resizeWrapper(
				matcher,
				startWrappedParent,
				start,
				startOffset,
				end,
				endOffset,
				'next'
			);
		}

		if (startWrappedParent && getSibling(startWrappedParent) === endWrapperParent) {
			return;
		}
	} else if (isSolidWrapper) {
		return;
	}

	if (start === end && isTextNode(start)) {
		if (startOffset < endOffset) {
			setRangeStart(range, start, startOffset);
			setRangeEnd(range, end, endOffset);
			surroundContents(range, cloneNode(wrapperElement));
		}

		return;
	}

	if (startWrappedParent && endWrapperParent) {
		endFrag = _deepUnwrap(<HTMLElement>endWrapperParent, matcher)[1];
		endFragOffset = getNodeLength(endFrag);
		endWrapperParent = null;
	}

	_applyStyle(
		matcher,
		startWrappedParent || endWrapperParent,
		wrapperElement,
		start,
		startOffset,
		endFrag || end,
		endFrag ? endFragOffset : endOffset,
		endWrapperParent ? 'prev' : 'next'
	);

	if (startWrappedParent || !startOffset) {
		range.setStart(start, startOffset);
	} else {
		range.setStartAfter(start);
	}

	if (!endSelected && endOffset > 0){
		range.setEndBefore(end);
	} else {
		range.setEnd(end, endOffset);
	}
}

// todo: удалить?
export function applyStyleBetween(start: RangePoint, end: RangePoint, tagName: string): Range {
	const range = createRange(start, end);

	applyStyle(range, tagName);
	return range
}

function _applyStyle(
	matcher: IDOMMatcher,
	wrapperParent: Node,
	wrapperElement: HTMLElement,
	start: Node,
	startOffset: number,
	end: Node,
	endOffset: number,
	vector: 'next' | 'prev'
) {
	const isPrevMode = vector === 'prev';

	if (start.compareDocumentPosition(end) & start.DOCUMENT_POSITION_PRECEDING) {
		// `end` идет перед `start`
		return;
	}

	if (isPrevMode) {
		[start, end] = [end, start];
		[endOffset, startOffset] = [startOffset, endOffset];
	}

	let cursor = start;
	let parentChanged: number;
	let range = createRange();
	let endRoot;
	let hasEnd;
	let isEndLast;
	let next;

	if (wrapperParent) {
		cursor = getSibling(wrapperParent, vector);

		if (cursor) {
			matcher.test(cursor) && (cursor = _deepUnwrap(<HTMLElement>cursor, matcher)[+isPrevMode]);
		} else {
			cursor = getParentSibling(wrapperParent, vector);
			wrapperParent = null;

			matcher.test(cursor) && (cursor = _deepUnwrap(<HTMLElement>cursor, matcher)[+isPrevMode]);
			range.setStartBefore(cursor);
		}
	} else {
		if (startOffset && getNodeLength(start) === startOffset) {
			// todo: надо дорабатывать логику `setRangeStart`
			range.setStartAfter(cursor);
		} else {
			setRangeStart(range, cursor, startOffset);
		}
	}

	do {
		next = null;

		if (cursor === end) {
			hasEnd = true;
			isEndLast = isPrevMode ? !endOffset : getNodeLength(end) === endOffset;
			parentChanged = 0;
		} else {
			hasEnd = cursor.contains(end);

			if (isPrevMode) {
				isEndLast = hasEnd && getMaxDeepNode(cursor, 0, 'end')[0] === end && !endOffset;
			} else {
				isEndLast = hasEnd && getMaxDeepNode(cursor, 'max', 'end')[0] === end && getNodeLength(end) === endOffset;
			}

			endRoot = endRoot || isEndLast && cursor;

			if (!isInlineElement(cursor) || hasEnd && !isEndLast) {
				next = isPrevMode ? cursor.lastChild : cursor.firstChild;
				parentChanged = +1;
			}

			if (!next && !isEndLast) {
				next = getSibling(cursor, vector);
				parentChanged = 0;

				if (!next) {
					next = getParentSibling(cursor, vector);
					parentChanged = -1;
				}
			}

			matcher.test(next) && (next = _deepUnwrap(<HTMLElement>next, matcher)[+isPrevMode]);
		}

		if (wrapperParent) {
			if (parentChanged) {
				!hasEnd && isInlineElement(cursor) && _insertNode(wrapperParent, cursor, vector);
				wrapperParent = null;
				range[isPrevMode ? 'setEndAfter' : 'setStartBefore'](next);
			} else {
				cursor = cursor === end && !isEndLast ? splitTextNode(<Text>cursor, endOffset)[+isPrevMode] : cursor;
				_insertNode(wrapperParent, cursor, vector);
			}
		} else {
			if (parentChanged) {
				if (parentChanged > 0) {
					range[isPrevMode ? 'setStartAfter' : 'setEndBefore'](cursor);
				} else {
					range[isPrevMode ? 'setStartBefore' : 'setEndAfter'](cursor);
				}

				surroundContents(range, cloneNode(wrapperElement));

				if (next) {
					if (isPrevMode) {
						range.setEnd(next, getNodeLength(next));
					} else {
						setRangeStart(range, next);
					}
				}
			} else if (cursor === end) {
				if (!isPrevMode && endOffset === getNodeLength(end)) {
					// todo: надо дорабатывать логику `setRangeEnd`
					range.setEndAfter(cursor);
				} else {
					range[isPrevMode ? 'setStart' : 'setEnd'](cursor, endOffset);
				}

				surroundContents(range, cloneNode(wrapperElement));

				return;
			} else if (hasEnd && isEndLast) {
				range[isPrevMode ? 'setStartBefore' : 'setEndAfter'](endRoot);
				surroundContents(range, cloneNode(wrapperElement));

				return;
			}
		}

		cursor = next;
	} while (next !== null);
}
