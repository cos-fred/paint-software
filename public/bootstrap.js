// Load app.js only after its shared stock rules are available. A failed asset
// should leave a useful retry screen instead of an unresponsive login form.
(() => {
    function failed() {
        document.getElementById('app').hidden = true;
        document.getElementById('startup-error').hidden = false;
    }
    document
        .getElementById('startup-retry')
        .addEventListener('click', () => location.reload());
    function load(source, ready) {
        const script = document.createElement('script');
        script.src = source;
        script.onload = ready;
        script.onerror = failed;
        document.body.appendChild(script);
    }
    load('/stock.js', () => {
        if (typeof window.PaintStock?.getProductStockStatus !== 'function')
            return failed();
        // launch-controls defines functions used when app.js handles DOM ready.
        load('/business-controls.js', () =>
            load('/launch-controls.js', () => load('/app.js', () => {}))
        );
    });
})();
