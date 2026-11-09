/* Formulaire de contact : envoi en POST JSON vers l'adresse indiquée dans data-endpoint.
   Aucun traceur, aucun secret, aucune donnée conservée dans le navigateur. */
(function () {
  'use strict';
  var form = document.getElementById('contact-form');
  if (!form) return;

  var endpoint = form.getAttribute('data-endpoint');
  var status = document.getElementById('status');
  var button = form.querySelector('button[type="submit"]');
  var ids = ['email', 'subject', 'message'];
  var messages = {
    email: {
      valueMissing: 'Saisissez votre adresse électronique.',
      typeMismatch: 'Saisissez une adresse électronique valide, avec le signe arobase.'
    },
    subject: { valueMissing: 'Saisissez le sujet de votre message.' },
    message: { valueMissing: 'Saisissez votre message.' }
  };

  function field(id) { return document.getElementById(id); }
  function errorBox(id) { return document.getElementById(id + '-err'); }

  function setStatus(kind, text) {
    status.className = 'status' + (kind ? ' ' + kind : '');
    status.textContent = text;
  }

  function clearErrors() {
    ids.forEach(function (id) {
      var input = field(id);
      var box = errorBox(id);
      input.removeAttribute('aria-invalid');
      box.hidden = true;
      box.textContent = '';
    });
  }

  function validate() {
    var firstInvalid = null;
    var count = 0;
    ids.forEach(function (id) {
      var input = field(id);
      input.value = input.value.trim();
      var v = input.validity;
      var text = '';
      if (v.valueMissing) text = messages[id].valueMissing;
      else if (v.typeMismatch) text = messages[id].typeMismatch;
      if (text) {
        count++;
        input.setAttribute('aria-invalid', 'true');
        var box = errorBox(id);
        box.textContent = 'Erreur : ' + text;
        box.hidden = false;
        if (!firstInvalid) firstInvalid = input;
      }
    });
    return firstInvalid ? { first: firstInvalid, count: count } : null;
  }

  function serverDetail(response) {
    return response.text().then(function (body) {
      var detail = '';
      try {
        var data = JSON.parse(body);
        detail = (data && (data.message || data.error)) || '';
      } catch (e) {
        detail = body;
      }
      return String(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
    }, function () { return ''; });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearErrors();

    var invalid = validate();
    if (invalid) {
      setStatus('err', 'Erreur : ' + invalid.count + (invalid.count > 1 ? ' champs sont à corriger.' : ' champ est à corriger.'));
      invalid.first.focus();
      return;
    }

    var payload = {
      email: field('email').value,
      subject: field('subject').value,
      message: field('message').value
    };

    button.disabled = true;
    setStatus('', 'Envoi en cours…');

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    }).then(function (response) {
      if (response.status === 201) {
        form.reset();
        setStatus('ok', 'Message envoyé');
        return;
      }
      return serverDetail(response).then(function (detail) {
        var text = 'Erreur : le message n’a pas été envoyé (code ' + response.status + ').';
        if (response.ok) text = 'Erreur : l’envoi n’est pas confirmé (code ' + response.status + ' reçu au lieu de 201).';
        if (detail) text += ' Réponse du serveur : ' + detail;
        setStatus('err', text);
      });
    }).catch(function (error) {
      var timedOut = error && error.name === 'AbortError';
      setStatus('err', timedOut
        ? 'Erreur : le serveur n’a pas répondu en 15 secondes. Réessayez plus tard.'
        : 'Erreur : impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.');
    }).then(function () {
      clearTimeout(timer);
      button.disabled = false;
    });
  });
})();
