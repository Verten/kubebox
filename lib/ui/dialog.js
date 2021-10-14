'use strict';
const blessed = require('blessed');

const dialog_ui = () => {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: '40%',
        height: '25%',
        label: 'Info',
        border: 'line',
        style: {
            label: {bold: true},
        },
    })

    const label = blessed.text({
        parent: box,
        left: 2,
        top: 2,
        align: 'left',
        content: 'Please wait for the plugin installing.',
    });

    const pluginUrl = blessed.textbox({
        parent: box,
        border: 'line',
        width: '100%-15',
        hidden: true,
        height: 3,
        top: 1,
        right: 1,
        inputOnFocus: true,
        mouse: true,
        keys: true,
    });

    const close = blessed.button({
        mouse   : true,
        keys    : true,
        shrink  : true,
        padding : {
            left  : 1,
            right : 1,
        },
        right   : 2,
        bottom  : 1,
        content : 'Close',
        style   : {
            focus : {
                bg : 'grey',
            },
            hover : {
                bg : 'grey',
            },
        },
    });

    return { box, label, pluginUrl, close }
}

const prompt = (screen, url) => {
    const { box, label, pluginUrl, close } = dialog_ui()
    pluginUrl.value = url

    setTimeout(() => {
        label.content = "Access URL:"
        pluginUrl.hidden = false
        box.append(close)
        screen.render()
        close.focus() // focus to close button
    }, 5000)

    close.on('press', () => handleClose())

    close.key(['escape'], () => {
        handleClose()
    })

    const handleOpen = () => {
        screen.saveFocus();
        screen.grabKeys = true;
        screen.grabMouse = true;
        screen.append(box)
        pluginUrl.grabMouse = true
        screen.render();
    }

    const handleClose = () => {
        box.destroy();
        screen.restoreFocus();
        screen.grabKeys = false;
        screen.grabMouse = false;
        screen.render();
    }

    handleOpen()
}

module.exports.prompt = prompt
